import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { checkPluginUpdates, isPluginSourceCheckable } = await jiti.import("./plugin-updates.ts");

function installedPackage(t, version = "1.0.0") {
  const path = mkdtempSync(join(tmpdir(), "pi-web-plugin-update-"));
  writeFileSync(join(path, "package.json"), JSON.stringify({ version }));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("only exact npm versions and Git refs are pinned", () => {
  assert.equal(isPluginSourceCheckable("npm:pkg@1.2.3"), false);
  assert.equal(isPluginSourceCheckable("npm:pkg@^1.2"), true);
  assert.equal(isPluginSourceCheckable("npm:pkg@~2"), true);
  assert.equal(isPluginSourceCheckable("npm:pkg@latest"), true);
  assert.equal(isPluginSourceCheckable("git:github.com/user/repo@feature/foo"), false);
  assert.equal(isPluginSourceCheckable("git:github.com/user/repo"), true);
});

test("a single-plugin check only runs that plugin's remote command", async (t) => {
  const first = installedPackage(t);
  const second = installedPackage(t);
  const checked = [];
  const results = await checkPluginUpdates("/tmp", { source: "npm:first", scope: "global" }, {
    packages: [
      { source: "npm:first", scope: "user", installedPath: first },
      { source: "npm:second", scope: "user", installedPath: second },
    ],
    runCommand: async (_command, args) => {
      checked.push(args[1]);
      return JSON.stringify("1.0.0");
    },
  });

  assert.deepEqual(checked, ["first"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].state, "up-to-date");
});

test("missing installs and failed commands return errors", async (t) => {
  const missing = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "npm:missing", scope: "user" }],
    runCommand: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(missing[0].state, "error");
  assert.match(missing[0].message, /not installed/i);

  const installedPath = installedPackage(t);
  const failed = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "npm:failed", scope: "user", installedPath }],
    runCommand: async () => {
      throw new Error("registry unavailable");
    },
  });
  assert.equal(failed[0].state, "error");
  assert.equal(failed[0].message, "registry unavailable");
});

test("npm checks compare the installed version with the selected range", async (t) => {
  const rangePath = installedPackage(t, "1.2.0");
  const latestPath = installedPackage(t, "2.0.0");
  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [
      { source: "npm:range@^1.2", scope: "user", installedPath: rangePath },
      { source: "npm:stable@latest", scope: "project", installedPath: latestPath },
    ],
    runCommand: async (_command, args) => args[1] === "range@^1.2"
      ? JSON.stringify(["1.2.0", "1.3.0", "2.0.0"])
      : JSON.stringify("2.0.0"),
  });

  assert.deepEqual(results.map((item) => item.state), ["update-available", "up-to-date"]);
});

test("Git checks compare local HEAD with the upstream remote ref", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  const ancestor = "c".repeat(40);
  let remote = local;
  const refs = [];
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD") return `${local}\n`;
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://github.com/user/repo\n";
    if (args[0] === "merge-base") {
      if (args[2] === local || args[2] === ancestor) return "";
      throw new Error("not an ancestor");
    }
    refs.push(args[2]);
    return `${remote}\trefs/heads/main\n`;
  };
  const packages = [{ source: "git:github.com/user/repo", scope: "user", installedPath }];

  const current = await checkPluginUpdates("/tmp", undefined, { packages, runCommand });
  remote = "b".repeat(40);
  const available = await checkPluginUpdates("/tmp", undefined, { packages, runCommand });
  remote = ancestor;
  const ahead = await checkPluginUpdates("/tmp", undefined, { packages, runCommand });

  assert.equal(current[0].state, "up-to-date");
  assert.equal(available[0].state, "update-available");
  assert.equal(ahead[0].state, "up-to-date");
  assert.deepEqual(refs, ["refs/heads/main", "refs/heads/main", "refs/heads/main"]);
});

test("Git checks fail closed when the checkout remote does not match the configured source", async (t) => {
  const installedPath = installedPackage(t);
  let lsRemoteCalls = 0;
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://github.com/attacker/repo\n";
    if (args[0] === "ls-remote") {
      lsRemoteCalls += 1;
      return "";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:github.com/user/repo", scope: "user", installedPath }],
    runCommand,
  });

  assert.equal(results[0].state, "error");
  assert.match(results[0].message, /remote/i);
  assert.equal(lsRemoteCalls, 0);
});

test("Git checks accept scp-style remotes matching the configured source", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "git@github.com:user/repo.git\n";
    if (args[0] === "merge-base") return "";
    return `${local}\trefs/heads/main\n`;
  };

  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:git@github.com:user/repo", scope: "user", installedPath }],
    runCommand,
  });

  assert.equal(results[0].state, "up-to-date");
});

test("Git checks compare the remote port with the configured source", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  let lsRemoteCalls = 0;
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://host:9443/org/repo\n";
    if (args[0] === "ls-remote") {
      lsRemoteCalls += 1;
      return "";
    }
    if (args[0] === "merge-base") return "";
    return `${local}\trefs/heads/main\n`;
  };
  const packages = [{ source: "git:https://host:8443/org/repo", scope: "user", installedPath }];

  const mismatched = await checkPluginUpdates("/tmp", undefined, { packages, runCommand });
  assert.equal(mismatched[0].state, "error");
  assert.equal(lsRemoteCalls, 0);

  const matching = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:https://host:8443/org/repo", scope: "user", installedPath }],
    runCommand: async (_command, args) => {
      if (args[0] === "rev-parse") return "origin/main\n";
      if (args[0] === "remote") return "https://host:8443/org/repo\n";
      if (args[0] === "merge-base") return "";
      return `${local}\trefs/heads/main\n`;
    },
  });
  assert.equal(matching[0].state, "up-to-date");
});

test("Git checks compare the remote protocol with the configured source", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  let lsRemoteCalls = 0;
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "ssh://host/org/repo\n";
    if (args[0] === "ls-remote") {
      lsRemoteCalls += 1;
      return "";
    }
    if (args[0] === "merge-base") return "";
    return `${local}\trefs/heads/main\n`;
  };

  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:https://host:22/org/repo", scope: "user", installedPath }],
    runCommand,
  });

  assert.equal(results[0].state, "error");
  assert.equal(lsRemoteCalls, 0);
});

test("Git checks normalize a trailing-slash .git source", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://host/org/repo.git\n";
    if (args[0] === "merge-base") return "";
    return `${local}\trefs/heads/main\n`;
  };

  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:https://host/org/repo.git/", scope: "user", installedPath }],
    runCommand,
  });

  assert.equal(results[0].state, "up-to-date");
});

test("Git checks normalize percent-encoded path segments", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://host/org/repo\n";
    if (args[0] === "merge-base") return "";
    return `${local}\trefs/heads/main\n`;
  };

  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:https://host/org/%72epo", scope: "user", installedPath }],
    runCommand,
  });

  assert.equal(results[0].state, "up-to-date");
});

test("Git checks fail closed when the remote has multiple fetch URLs", async (t) => {
  const installedPath = installedPackage(t);
  let lsRemoteCalls = 0;
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://github.com/user/repo\nhttps://github.com/attacker/repo\n";
    if (args[0] === "ls-remote") {
      lsRemoteCalls += 1;
      return "";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  const results = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:github.com/user/repo", scope: "user", installedPath }],
    runCommand,
  });

  assert.equal(results[0].state, "error");
  assert.match(results[0].message, /remote/i);
  assert.equal(lsRemoteCalls, 0);
});

test("Git checks validate the effective fetch URL after insteadOf rewrites", async (t) => {
  const installedPath = installedPackage(t);
  const local = "a".repeat(40);
  let lsRemoteCalls = 0;
  // get-url returns the rewritten URL git ls-remote will actually use; the
  // raw config value (gh:user/repo) is never seen by the check.
  const runCommand = async (_command, args) => {
    if (args[0] === "rev-parse") return "origin/main\n";
    if (args[0] === "remote") return "https://attacker.example/user/repo\n";
    if (args[0] === "ls-remote") {
      lsRemoteCalls += 1;
      return "";
    }
    if (args[0] === "merge-base") return "";
    return `${local}\trefs/heads/main\n`;
  };

  const rewritten = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:github.com/user/repo", scope: "user", installedPath }],
    runCommand,
  });
  assert.equal(rewritten[0].state, "error");
  assert.equal(lsRemoteCalls, 0);

  const matching = await checkPluginUpdates("/tmp", undefined, {
    packages: [{ source: "git:github.com/user/repo", scope: "user", installedPath }],
    runCommand: async (_command, args) => {
      if (args[0] === "rev-parse") return "origin/main\n";
      if (args[0] === "remote") return "https://github.com/user/repo\n";
      if (args[0] === "merge-base") return "";
      return `${local}\trefs/heads/main\n`;
    },
  });
  assert.equal(matching[0].state, "up-to-date");
});
