import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: checkPlugins } = await jiti.import("./route.ts");
const { invalidateSessionListCache } = await jiti.import("../../../../lib/session-reader.ts");
const { resetSessionScanIndexForTests } = await jiti.import("../../../../lib/session-list-scanner.ts");

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(tmpdir(), "pi-web-plugin-check-"));
  const sessionsDir = join(root, "sessions", "project");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  globalThis.__piAllowedRootsCache = undefined;
  invalidateSessionListCache();
  resetSessionScanIndexForTests();
  t.after(() => {
    globalThis.__piAllowedRootsCache = undefined;
    invalidateSessionListCache();
    resetSessionScanIndexForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  // A session whose cwd is the root makes the root an allowed file root.
  writeFileSync(join(sessionsDir, "fixture.jsonl"), JSON.stringify({
    type: "session",
    version: 3,
    id: "fixture",
    cwd: root,
    timestamp: "2026-01-01T00:00:00.000Z",
  }) + "\n");
  return root;
}

const post = (body) => new Request("http://localhost/api/plugins/check", {
  method: "POST",
  headers: { "content-type": "application/json", host: "localhost" },
  body,
});

test("invalid JSON is a stable 400 client error", async (t) => {
  fixture(t);
  const response = await checkPlugins(post("{not json"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
});

test("cwd resolving to a regular file is rejected before the check starts", async (t) => {
  const root = fixture(t);
  const filePath = join(root, "not-a-directory.txt");
  writeFileSync(filePath, "plain file");
  const response = await checkPlugins(post(JSON.stringify({ cwd: filePath })));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cwd must be a directory" });
});

test("a directory cwd inside an allowed root passes and returns the update list", async (t) => {
  const root = fixture(t);
  const response = await checkPlugins(post(JSON.stringify({ cwd: root })));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { updates: [] });
});

test("missing cwd is a 400 client error", async (t) => {
  fixture(t);
  const response = await checkPlugins(post(JSON.stringify({})));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cwd required" });
});

test("the canonical real path is the identity for trust and plugin checks", { skip: process.platform === "win32" }, async (t) => {
  const root = fixture(t);
  // A trust-requiring project (gated resources) reached through a symlink.
  const realProject = join(root, "real-project");
  const alias = join(root, "alias-project");
  mkdirSync(join(realProject, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(realProject, ".pi", "extensions", "probe.js"), "export default () => {};\n");
  writeFileSync(join(realProject, ".pi", "settings.json"), JSON.stringify({ packages: ["git:github.com/user/repo"] }));
  symlinkSync(realProject, alias, "dir");
  const trustPath = join(root, "trust.json");

  // A legacy trust entry under the lexical spelling must not grant trust to
  // the canonical path: project settings stay unloaded, so the project's
  // configured package is never checked.
  writeFileSync(trustPath, JSON.stringify({ [alias]: true }));
  const denied = await checkPlugins(post(JSON.stringify({ cwd: alias })));
  assert.equal(denied.status, 200);
  assert.deepEqual(await denied.json(), { updates: [] });

  // Trusting the canonical path makes the same request check the project's
  // configured package, found through the canonical project settings.
  writeFileSync(trustPath, JSON.stringify({ [realProject]: true }));
  const trusted = await checkPlugins(post(JSON.stringify({ cwd: alias })));
  assert.equal(trusted.status, 200);
  const body = await trusted.json();
  assert.equal(body.updates.length, 1);
  assert.equal(body.updates[0].state, "error");
  assert.match(body.updates[0].message, /not installed/i);
});

test("a JSON null body is a 400 client error, not a 500", async (t) => {
  fixture(t);
  const response = await checkPlugins(post("null"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cwd required" });
});
