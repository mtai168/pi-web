import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  SessionObserver,
  SESSION_OBSERVER_POLL_MS,
  SESSION_OBSERVER_STABILITY_MS,
  SESSION_OBSERVER_QUIET_MS,
} = await jiti.import("./session-observer.ts");

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
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

function sessionHeader(id) {
  return { type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd: "/tmp" };
}
function messageEntry(id, parentId, role, text, timestamp) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content: role === "assistant" ? [{ type: "text", text }] : text, timestamp: Date.parse(timestamp) },
  };
}
function line(entry) {
  return `${JSON.stringify(entry)}\n`;
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-observer-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let realBuildSnapshot;
let realEntryToMessage;
{
  const mod = await jiti.import("./session-observer.ts");
  realBuildSnapshot = mod.buildSessionObserverSnapshot;
  const reader = await jiti.import("./session-reader.ts");
  realEntryToMessage = (entry) => reader.sessionEntryToUiMessage(entry, {
    deferThinking: true,
    deferToolResultImages: true,
    sessionId: "s1",
  });
}

function createObserver(filePath, sessionId, timers, invalidateSpy) {
  return new SessionObserver(sessionId, filePath, {
    readFile: (path) => readFileSync(path, "utf8"),
    stat: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: invalidateSpy,
  });
}

function collect(observer) {
  const events = [];
  const unsubscribe = observer.onEvent((event) => events.push(event));
  return { events, unsubscribe };
}

test("connect emits a session_snapshot with the current transcript and leaf", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000); // mtime is older than the running window
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "hi there", "2025-01-01T00:00:02.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "session_snapshot");
    assert.equal(events[0].sessionId, "s1");
    assert.equal(events[0].snapshot.leafId, "e2");
    assert.equal(events[0].snapshot.context.messages.length, 2);
    assert.deepEqual(events[0].snapshot.context.entryIds, ["e1", "e2"]);
    // A stale mtime is not evidence of idle: the snapshot claims nothing.
    assert.equal(events[0].snapshot.running, undefined);
  });
});

test("appends emit agent_start + message_end and settle after quiet", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line(messageEntry("e2", "e1", "assistant", "hi there", "2025-01-01T00:00:02.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);

    assert.deepEqual(events.map((e) => e.type), ["agent_start", "message_end"]);
    assert.equal(events[1].message.content[0].text, "hi there");

    // A second append while running emits only the message event.
    events.length = 0;
    await appendFile(filePath, line(messageEntry("e3", "e2", "user", "again", "2025-01-01T00:00:03.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.deepEqual(events.map((e) => e.type), ["message_end"]);

    // Quiet period settles the brain status.
    events.length = 0;
    await timers.advance(SESSION_OBSERVER_QUIET_MS);
    assert.deepEqual(events.map((e) => e.type), ["agent_settled"]);
  });
});

test("a torn append is deferred until the line completes", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    // Partial line without a trailing newline: not applied yet.
    await appendFile(filePath, JSON.stringify(messageEntry("e2", "e1", "assistant", "hi", "2025-01-01T00:00:02.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.equal(events.length, 0);

    // The writer completes the line: applied on the next poll.
    await appendFile(filePath, "\n");
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.deepEqual(events.map((e) => e.type), ["agent_start", "message_end"]);
  });
});

test("a mid-write truncation never regresses to an older snapshot", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    const full = [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "hi there", "2025-01-01T00:00:02.000Z")),
      line(messageEntry("e3", "e2", "user", "more", "2025-01-01T00:00:03.000Z")),
    ].join("");
    await writeFile(filePath, full);

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    assert.equal(events[0].snapshot.context.messages.length, 3);
    events.length = 0;

    // A rewrite truncates the file to a strict prefix of the applied state
    // (writer mid-rewrite). The observer must keep the last applied state.
    await writeFile(filePath, full.slice(0, full.indexOf("e3")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    assert.equal(events.length, 0);

    // The rewrite completes with a new authoritative state: re-snapshot.
    const rewritten = [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line({ type: "compaction", id: "c1", parentId: "e1", summary: "compacted", firstKeptEntryId: "e1", tokensBefore: 100, timestamp: "2025-01-01T00:00:04.000Z" }),
      line(messageEntry("e4", "c1", "assistant", "final answer", "2025-01-01T00:00:05.000Z")),
    ].join("");
    await writeFile(filePath, rewritten);
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);

    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a re-snapshot after the rewrite completed");
    assert.equal(snapshot.snapshot.leafId, "e4");
    assert.deepEqual(snapshot.snapshot.context.entryIds, ["e1", "c1", "e4"]);
  });
});

test("a rewrite that keeps changing is only applied once stable", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    // Rewrite in progress: the stability probe sees different content each
    // time until the writer finishes. The rewritten content is not a prefix
    // of the previous state, so it takes the rewrite path.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello changed", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "partial", "2025-01-01T00:00:02.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello changed", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "complete", "2025-01-01T00:00:02.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    // Still changing: no snapshot yet.
    assert.equal(events.length, 0);

    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a snapshot once the rewrite stabilized");
    assert.equal(snapshot.snapshot.context.messages[1].content[0].text, "complete");
  });
});

test("session_info entries invalidate the list cache, emit a name event, and refresh the snapshot", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    let invalidated = 0;
    const observer = createObserver(filePath, "s1", timers, () => { invalidated += 1; });
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line({
      type: "session_info",
      id: "n1",
      parentId: "e1",
      name: "My Session",
      timestamp: "2025-01-01T00:00:02.000Z",
    }));
    await timers.advance(SESSION_OBSERVER_POLL_MS);

    assert.equal(invalidated, 1);
    // Metadata-only appends must not drive the running state, but the
    // snapshot refreshes so the viewer's name/thinking metadata stays fresh.
    assert.deepEqual(events.map((e) => e.type), ["session_info", "session_snapshot"]);
    assert.equal(events[0].name, "My Session");
    assert.equal(events[1].snapshot.name, "My Session");
  });
});

test("compaction entries emit compaction_start/end", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line({
      type: "compaction",
      id: "c1",
      parentId: "e1",
      summary: "compacted",
      firstKeptEntryId: "e1",
      tokensBefore: 100,
      timestamp: "2025-01-01T00:00:02.000Z",
    }));
    await timers.advance(SESSION_OBSERVER_POLL_MS);

    assert.deepEqual(events.map((e) => e.type), ["agent_start", "compaction_start", "compaction_end"]);
    assert.equal(events[2].tokensBefore, 100);
  });
});

test("reconnect re-emits an authoritative snapshot (server restart recovery)", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const first = createObserver(filePath, "s1", timers, () => {});
    const unsubscribeFirst = first.onEvent(() => {});
    unsubscribeFirst();

    // The external writer appends while the first stream is gone.
    await appendFile(filePath, line(messageEntry("e2", "e1", "assistant", "hi there", "2025-01-01T00:00:02.000Z")));

    // A fresh observer (reconnect after server restart) snapshots the full state.
    const second = createObserver(filePath, "s1", timers, () => {});
    const secondEvents = [];
    const unsubscribeSecond = second.onEvent((event) => secondEvents.push(event));
    t.after(unsubscribeSecond);

    assert.equal(secondEvents[0].type, "session_snapshot");
    assert.deepEqual(secondEvents[0].snapshot.context.entryIds, ["e1", "e2"]);
  });
});

test("a complete-but-malformed line is not skipped forever", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    // A complete line that is not valid JSON: nothing is applied and the
    // applied offset must not advance past it.
    await appendFile(filePath, "{not-json}\n");
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.equal(events.length, 0);

    // The writer repairs the file (the malformed line is replaced by a valid
    // entry): the entry after the repair is eventually observed instead of
    // being skipped forever.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "repaired", "2025-01-01T00:00:02.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.deepEqual(events.map((e) => e.type), ["agent_start", "message_end"]);
    assert.equal(events[1].message.content[0].text, "repaired");
  });
});

test("metadata-only appends do not drive the running state", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line({
      type: "session_info",
      id: "n1",
      parentId: "e1",
      name: "Renamed",
      timestamp: "2025-01-01T00:00:02.000Z",
    }));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.deepEqual(events.map((e) => e.type), ["session_info", "session_snapshot"]);

    // No agent_start was emitted, so no settle is expected either.
    events.length = 0;
    await timers.advance(SESSION_OBSERVER_QUIET_MS);
    assert.equal(events.length, 0);
  });
});

test("message_end events carry the entry id for branch metadata sync", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line(messageEntry("e2", "e1", "assistant", "hi", "2025-01-01T00:00:02.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    const messageEnd = events.find((e) => e.type === "message_end");
    assert.equal(messageEnd.entryId, "e2");
    assert.equal(messageEnd.sessionId, "s1");
  });
});

test("state-affecting metadata appends refresh the snapshot", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line({
      type: "label",
      id: "l1",
      parentId: "e1",
      targetId: "e1",
      label: "Branch A",
      timestamp: "2025-01-01T00:00:02.000Z",
    }));
    await timers.advance(SESSION_OBSERVER_POLL_MS);

    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a snapshot after a label append");
    assert.equal(snapshot.sessionId, "s1");
    // Metadata appends do not drive the running state, and a stale mtime is
    // not evidence of idle: the snapshot claims nothing.
    assert.equal(snapshot.snapshot.running, undefined);
  });
});

test("branch_summary and custom_message appends emit message_end", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line({
      type: "branch_summary",
      id: "b1",
      parentId: "e1",
      summary: "explored another branch",
      timestamp: "2025-01-01T00:00:02.000Z",
    }));
    await timers.advance(SESSION_OBSERVER_POLL_MS);

    assert.deepEqual(events.map((e) => e.type), ["agent_start", "message_end"]);
    assert.equal(events[1].message.role, "user");
    assert.match(events[1].message.content, /explored another branch/);
  });
});

test("a structurally invalid append reconciles via snapshot, not incrementally", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    // A duplicate entry id is structurally invalid: no incremental events.
    await appendFile(filePath, line(messageEntry("e1", "e1", "assistant", "dup", "2025-01-01T00:00:02.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    assert.equal(events.some((e) => e.type === "message_end"), false);
  });
});

test("a missing file is tolerated and snapshots when it appears", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    assert.equal(events.length, 0);

    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);

    assert.equal(events[0].type, "session_snapshot");
    assert.equal(events[0].snapshot.context.messages.length, 1);
  });
});

test("a cyclic parent chain never becomes the transcript", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    // e1 -> e3 -> e2 -> e1: every id is unique and no entry is a
    // self-reference, but the parent chain loops. The SDK's context walkers
    // hang on such a file, so it must never reach buildSessionContext.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", "e3", "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "hi", "2025-01-01T00:00:02.000Z")),
      line(messageEntry("e3", "e2", "assistant", "loop", "2025-01-01T00:00:03.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    assert.equal(events.length, 0);

    // The file is repaired: the snapshot is applied without hanging.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "hi", "2025-01-01T00:00:02.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);

    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a snapshot after the cycle was repaired");
    assert.deepEqual(snapshot.snapshot.context.entryIds, ["e1", "e2"]);
  });
});

test("a cycle closed by a forward reference into applied content is rejected", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    // e1's parent e2 is dangling in the applied state (acyclic by
    // construction); the tail then adds e2 with parent e1, closing a cycle
    // across the applied/tail boundary. The tail-only check cannot see it,
    // so the combined full-content check must reject the append.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", "e2", "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, line(messageEntry("e2", "e1", "assistant", "loop", "2025-01-01T00:00:02.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    assert.equal(events.some((e) => e.type === "message_end"), false);

    // The writer repairs the cycle: the stability re-check applies it. The
    // re-check backs off (200, 400, ...), so the repair is picked up on the
    // next re-check after the content change resets the budget.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "repaired", "2025-01-01T00:00:02.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);

    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a snapshot after the cycle was repaired");
    assert.deepEqual(snapshot.snapshot.context.entryIds, ["e1", "e2"]);
  });
});

test("a cyclic tail append reconciles via snapshot, never incrementally", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    // e2 -> e4 -> e3 -> e2 within the tail: a cycle that only exists in the
    // tail (e2 forward-references e4).
    await appendFile(filePath, [
      line(messageEntry("e2", "e4", "assistant", "a", "2025-01-01T00:00:02.000Z")),
      line(messageEntry("e3", "e2", "assistant", "b", "2025-01-01T00:00:03.000Z")),
      line(messageEntry("e4", "e3", "assistant", "c", "2025-01-01T00:00:04.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    assert.equal(events.some((e) => e.type === "message_end"), false);
  });
});

test("a repaired malformed tail is re-read promptly via the stability timer", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    await appendFile(filePath, "{not-json}\n");
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    assert.equal(events.length, 0);

    // The writer repairs the file. The repair is picked up by the stability
    // re-check alone — no poll is needed, so a same-stat repair cannot stay
    // stale until the periodic forced read.
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "repaired", "2025-01-01T00:00:02.000Z")),
    ].join(""));
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);

    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a snapshot after the repair");
    assert.equal(snapshot.snapshot.leafId, "e2");
  });
});

test("an off-branch append reconciles via a full snapshot, never message_end", async (t) => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "session.jsonl");
    const timers = createTimerQueue(Date.now() + 60_000);
    await writeFile(filePath, [
      line(sessionHeader("s1")),
      line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
      line(messageEntry("e2", "e1", "assistant", "hi", "2025-01-01T00:00:02.000Z")),
    ].join(""));

    const observer = createObserver(filePath, "s1", timers, () => {});
    const { events, unsubscribe } = collect(observer);
    t.after(unsubscribe);
    events.length = 0;

    // e3's parent is e1, not the applied leaf e2: a branch switch. The leaf
    // must never advance incrementally to an entry outside the active branch.
    await appendFile(filePath, line(messageEntry("e3", "e1", "assistant", "other branch", "2025-01-01T00:00:03.000Z")));
    await timers.advance(SESSION_OBSERVER_POLL_MS);
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);

    assert.equal(events.some((e) => e.type === "message_end"), false);
    const snapshot = events.find((e) => e.type === "session_snapshot");
    assert.ok(snapshot, "expected a full snapshot for the branch switch");
    assert.equal(snapshot.snapshot.leafId, "e3");
    assert.deepEqual(snapshot.snapshot.context.entryIds, ["e1", "e3"]);
  });
});

test("permanently malformed content backs off and stops the stability loop", async (t) => {
  const timers = createTimerQueue(1_000_000);
  const start = 1_000_000;
  const reads = [];
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => {
      reads.push(timers.now() - start);
      return "{not-json}\n";
    },
    stat: () => ({ size: 11, mtimeMs: 1_000 }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);
  reads.length = 0;

  // 12 seconds of fake time in 200ms steps.
  for (let step = 0; step < 60; step += 1) {
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
  }

  // The stability re-check loop is bounded and backed off: re-checks at
  // 1200, 1600, 2400, 4000, 5600 (delays 200, 400, 800, 1600, 1600; each
  // re-check reads once, then applySnapshot reads again), then the loop
  // stops and only the 1s poll reads remain. A tight 200ms loop would add
  // ~50 reads.
  assert.deepEqual(
    reads,
    [
      1_000, 1_200, 1_200, 1_600, 1_600, 2_000, 2_400, 2_400, 3_000,
      4_000, 4_000, 4_000, 5_000, 5_600, 5_600, 6_000, 7_000, 8_000,
      9_000, 10_000, 11_000, 12_000,
    ],
    `expected the backoff pattern, got ${JSON.stringify(reads)}`,
  );
  assert.equal(events.length, 0);
});

test("a same-stat repair after the retry budget is discovered at the next forced read", async (t) => {
  const timers = createTimerQueue(1_000_000);
  const valid = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
  ].join("");
  const repaired = [
    line(sessionHeader("s1")),
    line(messageEntry("e2", null, "user", "world", "2025-01-01T00:00:02.000Z")),
  ].join("");
  let content = valid;
  // Constant stat: the malformed rewrite and the repair both look identical
  // to the applied snapshot, so only a forced read makes the poll read once
  // the stability budget is exhausted.
  const stat = { size: valid.length, mtimeMs: 1_000 };
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => content,
    stat: () => stat,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);

  // Apply a valid snapshot first so lastStat is set.
  await timers.advance(SESSION_OBSERVER_POLL_MS);
  await timers.advance(SESSION_OBSERVER_STABILITY_MS);
  assert.equal(events.filter((e) => e.type === "session_snapshot").length, 1);
  events.length = 0;

  // Same-stat malformed rewrite: invisible to the fast path, detected at the
  // forced read (poll 30), then the stability retry budget is exhausted and
  // the fast path resumes.
  content = "{not-json}\n";
  for (let step = 0; step < 40; step += 1) {
    await timers.advance(SESSION_OBSERVER_POLL_MS);
  }
  assert.equal(events.length, 0);

  // Same-stat repair: the fast path skips unchanged polls, so the repair is
  // discovered at the next forced read (poll 60) and then applied.
  content = repaired;
  for (let step = 0; step < 30; step += 1) {
    await timers.advance(SESSION_OBSERVER_POLL_MS);
  }
  await timers.advance(SESSION_OBSERVER_STABILITY_MS);
  const snapshot = events.find((e) => e.type === "session_snapshot");
  assert.ok(snapshot, "expected a snapshot after the same-stat repair");
  assert.equal(snapshot.snapshot.context.messages.length, 1);
  assert.equal(snapshot.snapshot.context.entryIds[0], "e2");
});

test("a repair after the retry budget is still applied promptly", async (t) => {
  const timers = createTimerQueue(1_000_000);
  let content = "{not-json}\n";
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => content,
    stat: () => ({ size: 11, mtimeMs: 1_000 }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);
  events.length = 0;

  // Exhaust the stability retry budget on the malformed content.
  for (let step = 0; step < 60; step += 1) {
    await timers.advance(SESSION_OBSERVER_STABILITY_MS);
  }
  assert.equal(events.length, 0);

  // The writer repairs the file with the same size and mtime. The next poll
  // sees the new content (progress), resets the budget, and the stability
  // re-check applies the snapshot.
  content = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
  ].join("");
  await timers.advance(SESSION_OBSERVER_POLL_MS);
  await timers.advance(SESSION_OBSERVER_STABILITY_MS);

  const snapshot = events.find((e) => e.type === "session_snapshot");
  assert.ok(snapshot, "expected a snapshot after the repair");
  assert.equal(snapshot.snapshot.context.messages.length, 1);
});

test("a same-stat rewrite is detected by the periodic forced read", async (t) => {
  const timers = createTimerQueue(1_000_000);
  let content = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
  ].join("");
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => content,
    // Constant stat: the rewrite keeps the same size and mtime, so the fast
    // path skips reads until the periodic forced read.
    stat: () => ({ size: 123, mtimeMs: 1_000 }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);
  assert.equal(events[0].type, "session_snapshot");
  events.length = 0;

  // A same-stat rewrite: 29 polls skip it (fast path), the 30th poll is the
  // forced read and detects it.
  content = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello changed", "2025-01-01T00:00:01.000Z")),
  ].join("");
  for (let poll = 0; poll < 29; poll += 1) {
    await timers.advance(SESSION_OBSERVER_POLL_MS);
  }
  assert.equal(events.length, 0);

  await timers.advance(SESSION_OBSERVER_POLL_MS);
  await timers.advance(SESSION_OBSERVER_STABILITY_MS);
  const snapshot = events.find((e) => e.type === "session_snapshot");
  assert.ok(snapshot, "expected a snapshot after the forced read");
  assert.equal(snapshot.snapshot.context.messages[0].content, "hello changed");
});

test("a content change while a stability timer is pending restarts the quiet period", async (t) => {
  const timers = createTimerQueue(1_000_000);
  const valid = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
  ].join("");
  const malformed = "{not-json}\n";
  const rewritten = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello changed", "2025-01-01T00:00:01.000Z")),
    line(messageEntry("e2", "e1", "assistant", "complete", "2025-01-01T00:00:02.000Z")),
  ].join("");
  let content = valid;
  let stat = { size: valid.length, mtimeMs: 1_000 };
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => content,
    stat: () => stat,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);
  assert.equal(events[0].type, "session_snapshot");
  events.length = 0;

  // A malformed rewrite starts the stability backoff: checks at 1200, 1600,
  // then a pending check at 2400.
  content = malformed;
  stat = { size: malformed.length, mtimeMs: 2_000 };
  await timers.advance(SESSION_OBSERVER_POLL_MS); // t=1000: detected, check at 1200
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1200: still malformed, check at 1600
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1400: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1600: still malformed, check at 2400
  assert.equal(events.length, 0);

  // The writer completes the rewrite; the poll at t=2000 observes the new
  // content while the t=2400 check is still pending. The old deadline must
  // not apply the new content: the quiet period restarts from the change.
  content = rewritten;
  await timers.advance(SESSION_OBSERVER_POLL_MS); // t=2600: poll@2000 cancels the t=2400 check, schedules a fresh check at 2800
  assert.equal(events.length, 0, "the old stability deadline must not apply the new content");
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2800: full quiet period elapsed
  const snapshot = events.find((e) => e.type === "session_snapshot");
  assert.ok(snapshot, "expected a snapshot after a fresh quiet period");
  assert.equal(snapshot.snapshot.context.messages[1].content[0].text, "complete");
});

test("an empty rewrite stays pending and a same-stat repair is applied promptly", async (t) => {
  const timers = createTimerQueue(1_000_000);
  const valid = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
  ].join("");
  const malformed = "{not-json}\n";
  const repaired = [
    line(sessionHeader("s1")),
    line(messageEntry("e2", null, "user", "world", "2025-01-01T00:00:02.000Z")),
  ].join("");
  let content = valid;
  let stat = { size: valid.length, mtimeMs: 1_000 };
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => content,
    stat: () => stat,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);
  assert.equal(events[0].type, "session_snapshot");
  events.length = 0;

  // A malformed rewrite is detected; the writer then truncates the file to
  // empty mid-rewrite. The empty content becomes the pending rewrite.
  content = malformed;
  stat = { size: 456, mtimeMs: 3_000 };
  await timers.advance(SESSION_OBSERVER_POLL_MS); // t=1000: detected, check at 1200
  content = "";
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1200: empty content becomes pending, check at 1400
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1400: still empty: strict prefix, back off to 1800
  assert.equal(events.length, 0);

  // The writer repairs the file with the same size and mtime. The pending
  // empty rewrite keeps forcing reads, so the repair is applied after one
  // quiet period instead of waiting for the periodic forced read.
  content = repaired;
  await timers.advance(SESSION_OBSERVER_POLL_MS); // t=2400: the stability check at 1800 reads the repair, fresh check at 2600
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2600: apply
  const snapshot = events.find((e) => e.type === "session_snapshot");
  assert.ok(snapshot, "expected a snapshot after the empty-rewrite repair");
  assert.equal(snapshot.snapshot.context.messages.length, 1);
  assert.deepEqual(snapshot.snapshot.context.entryIds, ["e2"]);
});

test("an abandoned empty rewrite falls back to the forced-read interval", async (t) => {
  const timers = createTimerQueue(1_000_000);
  const valid = [
    line(sessionHeader("s1")),
    line(messageEntry("e1", null, "user", "hello", "2025-01-01T00:00:01.000Z")),
  ].join("");
  let content = valid;
  let stat = { size: valid.length, mtimeMs: 1_000 };
  let reads = 0;
  const observer = new SessionObserver("s1", "/tmp/session.jsonl", {
    readFile: () => { reads += 1; return content; },
    stat: () => stat,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    buildSnapshot: realBuildSnapshot,
    entryToMessage: realEntryToMessage,
    invalidateSessionListCache: () => {},
  });
  const { events, unsubscribe } = collect(observer);
  t.after(unsubscribe);
  assert.equal(events[0].type, "session_snapshot");
  reads = 0;
  events.length = 0;

  // A rewrite is detected, then the writer truncates to empty and abandons.
  content = "{not-json}\n";
  stat = { size: 456, mtimeMs: 3_000 };
  await timers.advance(SESSION_OBSERVER_POLL_MS); // t=1000: detected, check at 1200
  content = "";
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1200: empty becomes pending, check at 1400
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1400: strict prefix, back off to 1800
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1600: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=1800: strict prefix, back off to 2600
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2000: poll reads (pending forces reads)
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2200: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2400: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2600: strict prefix, back off to 4200
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=2800: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=3000: poll reads
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=3200: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=3400: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=3600: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=3800: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=4000: poll reads
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=4200: strict prefix, back off to 5800
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=4400: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=4600: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=4800: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=5000: poll reads
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=5200: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=5400: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=5600: nothing due
  await timers.advance(SESSION_OBSERVER_STABILITY_MS); // t=5800: retry budget exhausted, pending cleared
  const readsAtBudget = reads;
  assert.equal(events.length, 0);

  // The writer abandoned the truncation: the fast path now skips unchanged
  // polls, so reads stop until the periodic forced read.
  for (let step = 0; step < 20; step += 1) {
    await timers.advance(SESSION_OBSERVER_POLL_MS);
  }
  assert.equal(reads, readsAtBudget, "unchanged polls must not read after the budget");
  assert.equal(events.length, 0);
});
