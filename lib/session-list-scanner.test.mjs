import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { listSessionsIncremental, resetSessionScanIndexForTests } = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a });
  const c = write("c");
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => {
    opened.push(path);
    return createReadStream(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    opened.length = 0;
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    assert.deepEqual([...opened].sort(), [...expectedReads].sort(), `${label}: scanned files`);
  }

  await check("cold", [a, b, c]);
  await check("warm", []);
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("skips session files with invalid header id or timestamp", async (t) => {
  const { write } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("bad-date", [message("b1", "user", "broken")], { timestamp: "not-a-date" });
  write("no-id", [message("c1", "user", "broken")], { id: undefined });
  const scanned = await listSessionsIncremental();
  assert.deepEqual(scanned.map((s) => s.path), [a]);
  const sessions = await listAllSessions({ force: true });
  assert.deepEqual(sessions.map((s) => s.id), ["a"]);
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("persisted index state is isolated per agent directory", async (t) => {
  const { root, write } = fixture(t);
  const a = write("a", [message("a1", "user", "in A")]);
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => {
    opened.push(path);
    return createReadStream(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  // Re-import after the mock so this copy captures the mocked binding.
  const freshJiti = createJiti(import.meta.url, { moduleCache: false });
  const { listSessionsIncremental } = await freshJiti.import("./session-list-scanner.ts");

  await listSessionsIncremental();
  assert.deepEqual(opened, [a], "cold scan of A reads the session file");
  await new Promise((resolve) => setImmediate(resolve));

  const rootB = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-b-"));
  const dirB = join(rootB, "sessions", "project");
  fs.mkdirSync(dirB, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = rootB;
  t.after(() => fs.rmSync(rootB, { recursive: true, force: true }));
  const b = join(dirB, "b.jsonl");
  fs.writeFileSync(b, line({ type: "session", version: 3, id: "b", cwd: rootB, timestamp }) + line(message("b1", "user", "in B")));
  opened.length = 0;
  await listSessionsIncremental();
  assert.deepEqual(opened, [b], "cold scan of B reads the session file");
  await new Promise((resolve) => setImmediate(resolve));
  const persistedB = JSON.parse(fs.readFileSync(join(rootB, "pi-web-session-index.json"), "utf8"));
  assert.deepEqual(Object.keys(persistedB.entries), [b]);

  // Switching back must reload A's persisted index instead of reusing B's
  // in-memory state: an unchanged file is a cache hit, not a rescan.
  process.env.PI_CODING_AGENT_DIR = root;
  opened.length = 0;
  const scanned = await listSessionsIncremental();
  assert.deepEqual(scanned.map((s) => s.id), ["a"]);
  assert.deepEqual(opened, [], "switching back must reuse the persisted index");
});

test("equivalent agent-dir spellings share one canonical scan state", { skip: process.platform === "win32" }, async (t) => {
  const { root, write } = fixture(t);
  const a = write("a", [message("a1", "user", "in A")]);
  const alias = join(root, "agent-alias");
  fs.symlinkSync(root, alias, "dir");
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => {
    opened.push(path);
    return createReadStream(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const freshJiti = createJiti(import.meta.url, { moduleCache: false });
  const { listSessionsIncremental } = await freshJiti.import("./session-list-scanner.ts");

  process.env.PI_CODING_AGENT_DIR = alias;
  await listSessionsIncremental();
  assert.deepEqual(opened, [a], "cold scan through the alias reads the session file");
  await new Promise((resolve) => setImmediate(resolve));

  process.env.PI_CODING_AGENT_DIR = root;
  opened.length = 0;
  const scanned = await listSessionsIncremental();
  assert.deepEqual(scanned.map((s) => s.id), ["a"]);
  assert.deepEqual(opened, [], "the real spelling must reuse the alias's canonical state");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fs.existsSync(join(root, "pi-web-session-index.json")), "index persists under the canonical path");
});

test("an in-flight scan keeps its captured agent directory", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  const a = write("a", [message("a1", "user", "in A")]);
  const fifo = join(dir, "slow.jsonl");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return t.skip("mkfifo unavailable");
  }

  // The scan blocks opening the FIFO; switch directories while it is in flight.
  const scanPromise = listSessionsIncremental();
  const rootB = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-b-"));
  fs.mkdirSync(join(rootB, "sessions", "project"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = rootB;
  t.after(() => fs.rmSync(rootB, { recursive: true, force: true }));
  await fs.promises.writeFile(fifo, line({ type: "session", version: 3, id: "slow", cwd: root, timestamp }));

  const scanned = await scanPromise;
  assert.deepEqual(scanned.map((s) => s.id).sort(), ["a", "slow"]);
  await new Promise((resolve) => setImmediate(resolve));
  const persistedA = JSON.parse(fs.readFileSync(join(root, "pi-web-session-index.json"), "utf8"));
  assert.ok(persistedA.entries[a], "results must persist under the captured directory");
  assert.ok(!fs.existsSync(join(rootB, "pi-web-session-index.json")), "nothing may persist under the new directory");
});

test("overlapping scans of the same directory are coalesced", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  const a = write("a", [message("a1", "user", "in A")]);
  const fifo = join(dir, "slow.jsonl");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return t.skip("mkfifo unavailable");
  }

  const first = listSessionsIncremental();
  const second = listSessionsIncremental();
  await fs.promises.writeFile(fifo, line({ type: "session", version: 3, id: "slow", cwd: root, timestamp }));
  const [r1, r2] = await Promise.all([first, second]);
  assert.deepEqual(r1.map((s) => s.id).sort(), ["a", "slow"]);
  assert.deepEqual(r2.map((s) => s.id).sort(), ["a", "slow"], "the second scan must join the first");
});

test("overlapping scans of different agent directories do not clobber each other", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  const a = write("a", [message("a1", "user", "in A")]);
  const fifo = join(dir, "slow.jsonl");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return t.skip("mkfifo unavailable");
  }

  const scanA = listSessionsIncremental();
  const rootB = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-b-"));
  const dirB = join(rootB, "sessions", "project");
  fs.mkdirSync(dirB, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = rootB;
  t.after(() => fs.rmSync(rootB, { recursive: true, force: true }));
  const b = join(dirB, "b.jsonl");
  fs.writeFileSync(b, line({ type: "session", version: 3, id: "b", cwd: rootB, timestamp }) + line(message("b1", "user", "in B")));
  const scannedB = await listSessionsIncremental();
  assert.deepEqual(scannedB.map((s) => s.id), ["b"]);
  await fs.promises.writeFile(fifo, line({ type: "session", version: 3, id: "slow", cwd: root, timestamp }));
  const scannedA = await scanA;
  assert.deepEqual(scannedA.map((s) => s.id).sort(), ["a", "slow"]);
  await new Promise((resolve) => setImmediate(resolve));
  const persistedA = JSON.parse(fs.readFileSync(join(root, "pi-web-session-index.json"), "utf8"));
  assert.ok(persistedA.entries[a], "A's index must keep A's entries");
  const persistedB = JSON.parse(fs.readFileSync(join(rootB, "pi-web-session-index.json"), "utf8"));
  assert.ok(persistedB.entries[b], "B's index must keep B's entries");
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});
