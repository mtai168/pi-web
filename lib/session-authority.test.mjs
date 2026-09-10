import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  createSessionAuthorityManager,
  createExternalOwnerClient,
  SessionAuthorityError,
  SessionAppendError,
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
  EXTERNAL_RECHECK_MS,
  sessionLeasePath,
} = await jiti.import("./session-authority.ts");

// Manual timer queue: deterministic time control for lease renewal and
// external re-check cycles.
function createTimerQueue(initialNow) {
  let now = initialNow;
  let nextId = 1;
  const timers = [];
  return {
    now: () => now,
    setTimer(callback, ms) {
      const timer = { id: nextId++, callback, at: now + ms };
      timers.push(timer);
      return timer.id;
    },
    clearTimer(timer) {
      const index = timers.findIndex((t) => t.id === timer);
      if (index !== -1) timers.splice(index, 1);
    },
    async advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index === -1) continue;
        timers.splice(index, 1);
        timer.callback();
        // proper-lockfile resolves through several fs callback turns.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

function createFakeDeps(timers, externalOwnership) {
  return {
    now: timers.now,
    externalOwnership,
    readLease(leasePath) {
      try {
        const parsed = JSON.parse(readFileSync(leasePath, "utf8"));
        return parsed;
      } catch {
        return null;
      }
    },
    createLease(leasePath, lease) {
      writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { flag: "wx" });
    },
    replaceLease(leasePath, lease) {
      const tempPath = `${leasePath}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tempPath, `${JSON.stringify(lease)}\n`);
      renameSync(tempPath, leasePath);
    },
    removeLease(leasePath) {
      unlinkSync(leasePath);
    },
    async lockLease(leasePath) {
      const lockfile = (await import("proper-lockfile")).default;
      return lockfile.lock(leasePath, {
        realpath: false,
        stale: LEASE_TTL_MS,
        retries: { retries: 5, factor: 2, minTimeout: 20, maxTimeout: 100, randomize: false },
        onCompromised: () => {},
      });
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  };
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-authority-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertAuthorityError(promise, code) {
  return promise.then(
    () => assert.fail(`expected SessionAuthorityError with code ${code}`),
    (error) => {
      assert.ok(error instanceof SessionAuthorityError, `expected SessionAuthorityError, got ${error}`);
      assert.equal(error.code, code);
    },
  );
}

test("a second process cannot acquire mutation authority while the first owns it", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const handleA = await managerA.acquire("s1", sessionFile);
    t.after(() => handleA.release());
    assert.equal(handleA.isHeld(), true);

    await assertAuthorityError(managerB.acquire("s1", sessionFile), "lease_held");
    assert.equal(handleA.isHeld(), true);
  });
});

test("concurrent acquisition admits exactly one owner", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const results = await Promise.allSettled([
      managerA.acquire("s1", sessionFile),
      managerB.acquire("s1", sessionFile),
    ]);
    const winners = results.filter((result) => result.status === "fulfilled");
    const losers = results.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, "lease_held");
    t.after(() => winners[0].value.release());
  });
});

test("externally owned sessions fail closed before any lease is created", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "owned");
    const manager = createSessionAuthorityManager(deps);

    await assertAuthorityError(manager.acquire("s1", sessionFile), "externally_owned");
    await assert.rejects(readFile(sessionLeasePath(sessionFile), "utf8"), /ENOENT/);
  });
});

test("unverifiable ownership (external unreachable) fails closed", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "unreachable");
    const manager = createSessionAuthorityManager(deps);

    await assertAuthorityError(manager.acquire("s1", sessionFile), "authority_unverifiable");
  });
});

test("release allows another process to acquire", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const handleA = await managerA.acquire("s1", sessionFile);
    handleA.release();
    assert.equal(handleA.isHeld(), false);

    const handleB = await managerB.acquire("s1", sessionFile);
    t.after(() => handleB.release());
    assert.equal(handleB.isHeld(), true);
  });
});

test("a leftover lease of our own is re-acquirable (no self-lockout)", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const handle = await manager.acquire("s1", sessionFile);
    handle.release();
    // The release is asynchronous; the lease may still be on disk. A fresh
    // acquire must replace our own leftover lease instead of failing.
    const again = await manager.acquire("s1", sessionFile);
    t.after(() => again.release());
    assert.equal(again.isHeld(), true);
  });
});

test("a pending release deletion never removes a re-acquired lease", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const first = await manager.acquire("s1", sessionFile);
    first.release();
    // Re-acquire before the asynchronous release deletion has run.
    const second = await manager.acquire("s1", sessionFile);
    t.after(() => second.release());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The stale deletion must not have removed the re-acquired lease.
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    assert.equal(lease.ownerId, manager.ownerId);
    assert.equal(second.isHeld(), true);
  });
});

test("status reports free, lease_held, and externally_owned without acquiring", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    let external = "free";
    const deps = createFakeDeps(timers, async () => external);
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    assert.equal(await managerA.status("s1", sessionFile), "free");

    const handleA = await managerA.acquire("s1", sessionFile);
    t.after(() => handleA.release());
    assert.equal(await managerA.status("s1", sessionFile), "free"); // own lease
    assert.equal(await managerB.status("s1", sessionFile), "lease_held");

    external = "owned";
    assert.equal(await managerA.status("s1", sessionFile), "externally_owned");
    external = "unreachable";
    assert.equal(await managerA.status("s1", sessionFile), "authority_unverifiable");
  });
});

test("stale ownership from a crashed process is recovered by expiry, not by PID", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    await managerA.acquire("s1", sessionFile);
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    // Identity is a random UUID, never a PID: PID reuse cannot confuse owners.
    assert.match(lease.ownerId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(lease.ownerId, String(process.pid));

    // While the lease is fresh the session is locked to its owner.
    await assertAuthorityError(managerB.acquire("s1", sessionFile), "lease_held");

    // Simulate a crash: the owner stops renewing and its lease expires on
    // disk. Recovery is purely time-based, so a new process may take over
    // (no permanent lockout) without any PID/ancestry guesswork.
    const expired = { ...lease, expiresAt: timers.now() - 1 };
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify(expired)}\n`);
    const handleB = await managerB.acquire("s1", sessionFile);
    t.after(() => handleB.release());
    assert.equal(handleB.isHeld(), true);
    const taken = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    assert.equal(taken.ownerId, managerB.ownerId);
  });
});

test("renewal keeps the lease fresh while the owner lives", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const handleA = await managerA.acquire("s1", sessionFile);
    t.after(() => handleA.release());
    const first = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));

    // Renewal cycle keeps the expiry in the future; B still cannot acquire.
    await timers.advance(LEASE_RENEW_MS);
    const renewed = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    assert.ok(renewed.expiresAt > first.expiresAt);
    await assertAuthorityError(managerB.acquire("s1", sessionFile), "lease_held");
  });
});

test("renewal and external re-check repeat every cycle, not once", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    let externalChecks = 0;
    const deps = createFakeDeps(timers, async () => {
      externalChecks += 1;
      return "free";
    });
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const handleA = await managerA.acquire("s1", sessionFile);
    t.after(() => handleA.release());

    // Three full cycles: the lease must stay fresh and the external owner
    // must be re-checked on every cycle (one-shot timers would let the lease
    // expire and stop re-checking after the first cycle).
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await timers.advance(LEASE_RENEW_MS);
      const current = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
      assert.ok(current.expiresAt > timers.now(), `cycle ${cycle}: lease expired`);
      await assertAuthorityError(managerB.acquire("s1", sessionFile), "lease_held");
    }
    assert.ok(externalChecks >= 3, `expected repeated external checks, got ${externalChecks}`);
  });
});

test("reentrant acquisition in one process shares the held authority", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const primary = await manager.acquire("s1", sessionFile);
    const secondary = await manager.acquire("s1", sessionFile);
    t.after(() => primary.release());

    // Releasing the secondary handle must not drop the lease the primary
    // holder still depends on.
    secondary.release();
    assert.equal(primary.isHeld(), true);
    assert.equal(secondary.isHeld(), true);
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    assert.equal(lease.ownerId, manager.ownerId);

    // The primary release drops the lease for real.
    primary.release();
    assert.equal(primary.isHeld(), false);
    assert.equal(secondary.isHeld(), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(readFile(sessionLeasePath(sessionFile), "utf8"), /ENOENT/);
  });
});

test("a lease taken over by another owner revokes the original holder", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const handleA = await managerA.acquire("s1", sessionFile);
    let revoked = false;
    handleA.onRevoked(() => { revoked = true; });

    // A's renewal is delayed past expiry (wedged event loop); B takes over
    // the expired lease.
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({ ...lease, expiresAt: timers.now() - 1 })}\n`);
    const handleB = await managerB.acquire("s1", sessionFile);
    t.after(() => handleB.release());

    // A's next renewal sees the foreign owner and revokes.
    await timers.advance(LEASE_RENEW_MS);
    assert.equal(revoked, true);
    assert.equal(handleA.isHeld(), false);
    assert.equal(handleB.isHeld(), true);
  });
});

test("external takeover while held revokes and removes the lease", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    let external = "free";
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => external);
    const manager = createSessionAuthorityManager(deps);

    const handle = await manager.acquire("s1", sessionFile);
    let revoked = false;
    handle.onRevoked(() => { revoked = true; });

    external = "owned";
    await timers.advance(EXTERNAL_RECHECK_MS);
    assert.equal(revoked, true);
    assert.equal(handle.isHeld(), false);
    await assert.rejects(readFile(sessionLeasePath(sessionFile), "utf8"), /ENOENT/);
  });
});

test("unreachable external owner while held revokes (fail closed)", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    let external = "free";
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => external);
    const manager = createSessionAuthorityManager(deps);

    const handle = await manager.acquire("s1", sessionFile);
    let revoked = false;
    handle.onRevoked(() => { revoked = true; });

    external = "unreachable";
    await timers.advance(EXTERNAL_RECHECK_MS);
    assert.equal(revoked, true);
    assert.equal(handle.isHeld(), false);
  });
});

test("external owner client reads the configured process API and fails closed", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/api/agent/owned-session") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ running: true }));
      return;
    }
    if (req.url === "/api/agent/free-session") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ running: false }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const client = createExternalOwnerClient({ baseUrl, fetchImpl: fetch });
  assert.equal(await client.check("owned-session"), "owned");
  assert.equal(await client.check("free-session"), "free");
  assert.equal(await client.check("unknown-session"), "unreachable");

  const downClient = createExternalOwnerClient({
    baseUrl: "http://127.0.0.1:1",
    timeoutMs: 200,
    fetchImpl: fetch,
  });
  assert.equal(await downClient.check("free-session"), "unreachable");

  const unconfigured = createExternalOwnerClient({ baseUrl: undefined });
  assert.equal(unconfigured.isConfigured(), false);
  assert.equal(await unconfigured.check("free-session"), "free");
});

test("external owner responses with a non-boolean shape fail closed", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/agent/missing-field") res.end(JSON.stringify({}));
    else if (req.url === "/api/agent/string-running") res.end(JSON.stringify({ running: "yes" }));
    else res.end("not json");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = createExternalOwnerClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    fetchImpl: fetch,
  });

  // Only an explicit boolean `running` proves ownership either way; every
  // other shape is unverifiable and must fail closed.
  assert.equal(await client.check("missing-field"), "unreachable");
  assert.equal(await client.check("string-running"), "unreachable");
  assert.equal(await client.check("garbage"), "unreachable");
});

// ============================================================================
// Fenced append API
// ============================================================================

function createAppender(sessionFile) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    appendCustomEntry(customType, data) {
      calls.push({ kind: "custom_entry", customType, data });
      const id = `id-${nextId++}`;
      appendFileSync(sessionFile, `${JSON.stringify({ type: "custom", id, customType, data })}\n`);
      return id;
    },
    appendSessionInfo(name) {
      calls.push({ kind: "session_info", name });
      const id = `id-${nextId++}`;
      appendFileSync(sessionFile, `${JSON.stringify({ type: "session_info", id, name })}\n`);
      return id;
    },
  };
}

test("the public handle exposes no arbitrary callback mutation API", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const handle = await manager.acquire("s1", sessionFile);
    // The escape hatch is gone: a plain handle has no append API at all, and
    // the appender-bound handle accepts only the closed declarative
    // operations array — no function, promise, thenable, or thunk per call.
    assert.equal(typeof handle.appendSessionEntries, "undefined");
    handle.release();
    const appender = createAppender(sessionFile);
    const bound = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => bound.release());
    assert.equal(typeof bound.appendSessionEntries, "function");
    await assert.rejects(
      bound.appendSessionEntries(appender, [
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      /operations must be an array/,
    );
    assert.deepEqual(appender.calls, []);
  });
});

test("a fenced append sequence runs while the lease is provably held", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => handle.release());
    const ids = await handle.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: { version: 1 } },
      { kind: "session_info", name: "My Session" },
    ]);
    assert.equal(ids.length, 2);
    assert.deepEqual(appender.calls, [
      { kind: "custom_entry", customType: "meta", data: { version: 1 } },
      { kind: "session_info", name: "My Session" },
    ]);
    assert.match(await readFile(sessionFile, "utf8"), /"customType":"meta"/);
    assert.match(await readFile(sessionFile, "utf8"), /"type":"session_info"/);
    assert.equal(handle.isHeld(), true);
  });
});

test("invalid append operations fail before any append", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => handle.release());
    const before = await readFile(sessionFile, "utf8");

    // Unknown kind, empty customType, and non-string name are all rejected
    // before the mutex is even taken: no append can run, so a sequence can
    // never be partially applied.
    for (const operations of [
      [{ kind: "unknown", customType: "x" }],
      [{ kind: "custom_entry", customType: "" }],
      [{ kind: "session_info", name: 42 }],
      [
        { kind: "custom_entry", customType: "meta", data: {} },
        { kind: "bogus" },
      ],
    ]) {
      await assert.rejects(
        handle.appendSessionEntries(operations),
        /unknown operation kind|non-empty customType|name string/,
      );
      assert.deepEqual(appender.calls, []);
      assert.equal(await readFile(sessionFile, "utf8"), before);
    }

    // A valid sequence still works after the rejected ones: the mutex was
    // released and nothing was written.
    await handle.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appender.calls.length, 1);
  });
});

test("a fenced append after revocation writes nothing", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const managerA = createSessionAuthorityManager(deps);
    const managerB = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handleA = await managerA.acquireSessionAppender("s1", sessionFile, appender);
    let revoked = false;
    handleA.onRevoked(() => { revoked = true; });

    // B takes over the expired lease; A's next renewal sees the foreign
    // owner and revokes — the exact interleaving that used to race the
    // check-then-write append.
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({ ...lease, expiresAt: timers.now() - 1 })}\n`);
    const handleB = await managerB.acquire("s1", sessionFile);
    t.after(() => handleB.release());
    await timers.advance(LEASE_RENEW_MS);
    assert.equal(revoked, true);
    assert.equal(handleA.isHeld(), false);

    const before = await readFile(sessionFile, "utf8");
    await assert.rejects(
      handleA.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(appender.calls, []);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });
});

test("a fenced append re-reads the lease and rejects a foreign takeover", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    // A foreign owner replaces the lease on disk before the handle's renewal
    // has noticed: the fence must re-read and reject under the mutex.
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({
      ownerId: "22222222-3333-4444-5555-666666666666",
      sessionId: "s1",
      sessionFile,
      acquiredAt: timers.now(),
      expiresAt: timers.now() + 60_000,
      version: 1,
      token: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    })}\n`);
    const before = await readFile(sessionFile, "utf8");
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(appender.calls, []);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });
});

test("a fenced append rejects a missing or expired lease", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    const before = await readFile(sessionFile, "utf8");
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));

    // Missing lease: the fence cannot prove the mutation is authorized.
    unlinkSync(sessionLeasePath(sessionFile));
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(appender.calls, []);
    assert.equal(await readFile(sessionFile, "utf8"), before);

    // Expired lease (same owner/token): the fence rejects too.
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({ ...lease, expiresAt: timers.now() - 1 })}\n`);
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(appender.calls, []);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });
});

test("a fenced append releases the mutex when the appender throws", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const throwingAppender = {
      appendCustomEntry() { throw new Error("boom"); },
      appendSessionInfo() { throw new Error("boom"); },
    };
    const handle = await manager.acquireSessionAppender("s1", sessionFile, throwingAppender);
    t.after(() => handle.release());
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAppendError && error.appliedCount === 0,
    );
    // The mutex was released in finally: a fresh acquisition with a working
    // appender succeeds.
    handle.release();
    const appender = createAppender(sessionFile);
    const rebound = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => rebound.release());
    await rebound.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appender.calls.length, 1);
  });
});

test("a later-operation appender failure reports appliedCount and releases the mutex", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const calls = [];
    const failingAppender = {
      appendCustomEntry(customType, data) {
        calls.push(["custom_entry", customType, data]);
        return "id-1";
      },
      appendSessionInfo() {
        throw new Error("disk full");
      },
    };
    const handle = await manager.acquireSessionAppender("s1", sessionFile, failingAppender);
    t.after(() => handle.release());
    // The first operation is applied before the second throws: the typed
    // rejection reports the partial application (appliedCount=1) and the
    // mutex is released. The caller must not retry the sequence.
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
        { kind: "session_info", name: "My Session" },
      ]),
      (error) => error instanceof SessionAppendError
        && error.appliedCount === 1
        && error.cause instanceof Error
        && error.cause.message === "disk full",
    );
    assert.deepEqual(calls, [["custom_entry", "meta", {}]]);
    // The mutex was released: a fresh acquisition with a working appender
    // succeeds.
    handle.release();
    const appender = createAppender(sessionFile);
    const rebound = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => rebound.release());
    await rebound.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appender.calls.length, 1);
  });
});

test("an appender returning a non-string is rejected before the lease is released", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    // A non-string result (including a thenable resolving to a non-string)
    // fails the sequence while the lease is still held, carrying the
    // partial-application count.
    const badAppender = {
      appendCustomEntry() { return 42; },
      appendSessionInfo() { return Promise.resolve(42); },
    };
    const handle = await manager.acquireSessionAppender("s1", sessionFile, badAppender);
    t.after(() => handle.release());
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAppendError
        && error.appliedCount === 0
        && /must return a string synchronously/.test(error.message),
    );
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "session_info", name: "My Session" },
      ]),
      (error) => error instanceof SessionAppendError
        && error.appliedCount === 0
        && /must return a string synchronously/.test(error.message),
    );
    // A non-string result after an earlier applied operation reports the
    // partial application: appliedCount=1, never a bare TypeError.
    handle.release();
    const mixedAppender = {
      appendCustomEntry() { return "id-1"; },
      appendSessionInfo() { return 42; },
    };
    const mixed = await manager.acquireSessionAppender("s1", sessionFile, mixedAppender);
    t.after(() => mixed.release());
    await assert.rejects(
      mixed.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
        { kind: "session_info", name: "My Session" },
      ]),
      (error) => error instanceof SessionAppendError
        && error.appliedCount === 1
        && /must return a string synchronously/.test(error.message),
    );
    mixed.release();
    // The mutex was released: a fresh acquisition with a working appender
    // succeeds.
    const appender = createAppender(sessionFile);
    const rebound = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => rebound.release());
    await rebound.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appender.calls.length, 1);
  });
});

test("an async appender is rejected at acquisition and never invoked", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    let invoked = false;
    const asyncAppender = {
      async appendCustomEntry() {
        invoked = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "late-id";
      },
      appendSessionInfo() { return "id-2"; },
    };
    // An async implementation is rejected before it can execute: its
    // synchronous prefix could write before the first await and its deferred
    // continuation would run after the fence releases.
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, asyncAppender),
      /appender methods must be synchronous/,
    );
    assert.equal(invoked, false);
    // No lease was created for the rejected acquisition.
    await assert.rejects(readFile(sessionLeasePath(sessionFile), "utf8"), /ENOENT/);
  });
});

test("a sync appender returning a thenable is rejected and its settlement is swallowed", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    // A synchronous-looking method that returns a thenable passes the
    // acquisition check (bound/transpiled async): the runtime string check
    // rejects the first append, and the thenable's rejection is swallowed so
    // it can never surface as an unhandled rejection.
    const thenableAppender = {
      appendCustomEntry() { return Promise.reject(new Error("late failure")); },
      appendSessionInfo() { return "id-2"; },
    };
    const handle = await manager.acquireSessionAppender("s1", sessionFile, thenableAppender);
    t.after(() => handle.release());
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAppendError
        && error.appliedCount === 0
        && /must return a string synchronously/.test(error.message),
    );
    // Give the swallowed rejection time to surface: an unhandled rejection
    // would fail the test process.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

test("a caller mutating the batch while the mutex is pending cannot bypass validation", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    // Manual mutex: the test holds the lock so the fence blocks on
    // acquisition while the caller mutates the operations array.
    let lockHeld = false;
    const lockQueue = [];
    const releaseLock = () => {
      lockHeld = false;
      const next = lockQueue.shift();
      if (next) next();
    };
    const deps = {
      now: timers.now,
      externalOwnership: async () => "free",
      readLease(leasePath) {
        try {
          return JSON.parse(readFileSync(leasePath, "utf8"));
        } catch {
          return null;
        }
      },
      createLease(leasePath, lease) {
        writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { flag: "wx" });
      },
      replaceLease(leasePath, lease) {
        const tempPath = `${leasePath}.${Math.random().toString(36).slice(2)}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(lease)}\n`);
        renameSync(tempPath, leasePath);
      },
      removeLease(leasePath) {
        unlinkSync(leasePath);
      },
      async lockLease() {
        if (!lockHeld) {
          lockHeld = true;
          return releaseLock;
        }
        return new Promise((resolve) => lockQueue.push(() => { lockHeld = true; resolve(releaseLock); }));
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    };
    const manager = createSessionAuthorityManager(deps);
    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => handle.release());

    const testLock = await deps.lockLease();
    const operations = [{ kind: "custom_entry", customType: "meta", data: { version: 1 } }];
    const fence = handle.appendSessionEntries(operations);
    // While the fence waits for the mutex, the caller rewrites the operation
    // kind and its nested payload: the snapshot taken before the await must
    // win for both.
    operations[0].kind = "bogus";
    operations[0].data.version = 999;
    testLock();
    const ids = await fence;
    assert.equal(ids.length, 1);
    assert.deepEqual(appender.calls, [{ kind: "custom_entry", customType: "meta", data: { version: 1 } }]);
  });
});

test("a fenced append extends the lease for the batch duration", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => handle.release());
    // Age the lease: the fence's entry check still passes, and the renewal
    // extends the lease so the synchronous appends cannot outlive it.
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({ ...lease, expiresAt: timers.now() + 5_000 })}\n`);
    await handle.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    const after = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    assert.equal(after.expiresAt, timers.now() + LEASE_TTL_MS);
    assert.equal(after.token, lease.token);
  });
});

test("a fenced append rejects a lease rewritten with a different version", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    // Same owner and token, but a different lease version: the fence must
    // not treat the rewritten lease as the exact generation it acquired.
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({ ...lease, version: lease.version + 1 })}\n`);
    const before = await readFile(sessionFile, "utf8");
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(appender.calls, []);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });
});

test("a revocation racing the fence cannot interleave a write", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    // Manual mutex: the test holds the lock so the fence blocks on
    // acquisition while the revocation happens.
    let lockHeld = false;
    const lockQueue = [];
    const releaseLock = () => {
      lockHeld = false;
      const next = lockQueue.shift();
      if (next) next();
    };
    const deps = {
      now: timers.now,
      externalOwnership: async () => external,
      readLease(leasePath) {
        try {
          return JSON.parse(readFileSync(leasePath, "utf8"));
        } catch {
          return null;
        }
      },
      createLease(leasePath, lease) {
        writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { flag: "wx" });
      },
      replaceLease(leasePath, lease) {
        const tempPath = `${leasePath}.${Math.random().toString(36).slice(2)}.tmp`;
        writeFileSync(tempPath, `${JSON.stringify(lease)}\n`);
        renameSync(tempPath, leasePath);
      },
      removeLease(leasePath) {
        unlinkSync(leasePath);
      },
      async lockLease() {
        if (!lockHeld) {
          lockHeld = true;
          return releaseLock;
        }
        return new Promise((resolve) => lockQueue.push(() => { lockHeld = true; resolve(releaseLock); }));
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    };
    let external = "free";
    const manager = createSessionAuthorityManager(deps);
    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    let revoked = false;
    handle.onRevoked(() => { revoked = true; });

    // Hold the lease mutex so the fence blocks on lock acquisition.
    const testLock = await deps.lockLease();
    const fence = handle.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    // The fence is in flight; the external owner takes over and the re-check
    // revokes the handle while the fence waits for the mutex.
    external = "owned";
    await timers.advance(EXTERNAL_RECHECK_MS);
    assert.equal(revoked, true);
    // Release the mutex: the fence acquires it, re-verifies, and rejects.
    testLock();
    await assert.rejects(
      fence,
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(appender.calls, []);
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"session","id":"s1"}\n');
  });
});

test("a mid-batch lease rewrite stops the remaining operations", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const calls = [];
    const rewritingAppender = {
      appendCustomEntry(customType, data) {
        calls.push(["custom_entry", customType, data]);
        // Simulate a takeover that bypasses the mutex (defense-in-depth):
        // the per-operation re-read must deny the remaining operations.
        writeFileSync(sessionLeasePath(sessionFile), `${JSON.stringify({
          ownerId: "22222222-3333-4444-5555-666666666666",
          sessionId: "s1",
          sessionFile,
          acquiredAt: timers.now(),
          expiresAt: timers.now() + 60_000,
          version: 1,
          token: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        })}\n`);
        return "id-1";
      },
      appendSessionInfo(name) {
        calls.push(["session_info", name]);
        return `id-${name}`;
      },
    };
    const handle = await manager.acquireSessionAppender("s1", sessionFile, rewritingAppender);
    t.after(() => handle.release());
    await assert.rejects(
      handle.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
        { kind: "session_info", name: "My Session" },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.deepEqual(calls, [["custom_entry", "meta", {}]]);
  });
});

test("post-acquisition method replacement cannot redirect the bound appender", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const handle = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => handle.release());
    // Replace the appender's method after acquisition: the authority keeps
    // invoking the method snapshot taken at acquisition, so the fence cannot
    // be redirected to another session's appender.
    appender.appendCustomEntry = () => { throw new Error("replaced"); };
    await handle.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appender.calls.length, 1);
  });
});

test("a reentrant acquire never writes a replacement lease for a missing lease file", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const primary = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => primary.release());
    // The lease file disappears while the authority is held (external
    // deletion): a reentrant acquire must share the active authority without
    // writing a replacement lease that would orphan its generation.
    unlinkSync(sessionLeasePath(sessionFile));
    const secondary = await manager.acquireSessionAppender("s1", sessionFile, appender);
    assert.equal(secondary.isHeld(), true);
    assert.equal(primary.isHeld(), true);
    // A different binding is rejected without writing a lease either.
    const other = createAppender(sessionFile);
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, other),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_held",
    );
    await assert.rejects(readFile(sessionLeasePath(sessionFile), "utf8"), /ENOENT/);
  });
});

test("reentrant acquisition fails closed on external probe errors", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    let external = "free";
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => external);
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const primary = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => primary.release());
    // The external owner becomes unreachable/owned while the authority is
    // held: reentrant acquisition still fails closed (the active authority's
    // own re-check will revoke it) instead of sharing a doomed authority.
    external = "unreachable";
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, appender),
      (error) => error instanceof SessionAuthorityError && error.code === "authority_unverifiable",
    );
    external = "owned";
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, appender),
      (error) => error instanceof SessionAuthorityError && error.code === "externally_owned",
    );
  });
});

test("a reentrant acquire for a different session file is rejected", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    const otherFile = join(dir, "other.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    await writeFile(otherFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const primary = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => primary.release());
    // Same session id, different file: the reentrant path must reject
    // instead of routing mutations to the original file.
    await assert.rejects(
      manager.acquireSessionAppender("s1", otherFile, appender),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_held",
    );
    // The original authority is unaffected.
    assert.equal(primary.isHeld(), true);
  });
});

test("a reentrant handle fences through the shared authority", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appender = createAppender(sessionFile);
    const primary = await manager.acquireSessionAppender("s1", sessionFile, appender);
    const secondary = await manager.acquireSessionAppender("s1", sessionFile, appender);
    t.after(() => primary.release());

    await secondary.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appender.calls.length, 1);

    // After the primary releases, the shared authority is gone: the
    // secondary handle's fence rejects.
    primary.release();
    const before = await readFile(sessionFile, "utf8");
    await assert.rejects(
      secondary.appendSessionEntries([
        { kind: "custom_entry", customType: "meta", data: {} },
      ]),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_lost",
    );
    assert.equal(appender.calls.length, 1);
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });
});

test("reentrant appender acquisition shares only the same bound appender", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const appenderA = createAppender(sessionFile);
    const primary = await manager.acquireSessionAppender("s1", sessionFile, appenderA);
    t.after(() => primary.release());
    // Same appender instance: the reentrant handle shares the authority.
    const same = await manager.acquireSessionAppender("s1", sessionFile, appenderA);
    await same.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appenderA.calls.length, 1);
    // A different appender instance is rejected: the binding is never
    // silently swapped for another child/session appender.
    const appenderB = createAppender(sessionFile);
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, appenderB),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_held",
    );
    // A plain reentrant acquire shares without exposing the append API.
    const plain = await manager.acquire("s1", sessionFile);
    assert.equal(typeof plain.appendSessionEntries, "undefined");
    // The bound handle still appends through the original appender only.
    await primary.appendSessionEntries([
      { kind: "custom_entry", customType: "meta", data: {} },
    ]);
    assert.equal(appenderA.calls.length, 2);
    assert.equal(appenderB.calls.length, 0);
  });
});

test("appender acquisition rejects a session already held without a binding", async (t) => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    const plain = await manager.acquire("s1", sessionFile);
    t.after(() => plain.release());
    const appender = createAppender(sessionFile);
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, appender),
      (error) => error instanceof SessionAuthorityError && error.code === "lease_held",
    );
    // The plain handle is unaffected and the lease is untouched.
    assert.equal(plain.isHeld(), true);
    const lease = JSON.parse(await readFile(sessionLeasePath(sessionFile), "utf8"));
    assert.equal(lease.ownerId, manager.ownerId);
  });
});

test("acquireSessionAppender rejects a structurally invalid appender", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session","id":"s1"}\n');
    const timers = createTimerQueue(1_000_000);
    const deps = createFakeDeps(timers, async () => "free");
    const manager = createSessionAuthorityManager(deps);

    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, { appendCustomEntry: () => "id" }),
      /must provide appendCustomEntry and appendSessionInfo/,
    );
    await assert.rejects(
      manager.acquireSessionAppender("s1", sessionFile, {}),
      /must provide appendCustomEntry and appendSessionInfo/,
    );
    // No lease was created for the rejected acquisitions.
    await assert.rejects(readFile(sessionLeasePath(sessionFile), "utf8"), /ENOENT/);
  });
});
