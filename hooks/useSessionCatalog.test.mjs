import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useSessionCatalog.ts", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
const {
  createRunningSessionPoller,
  createSessionCatalogRequester,
  getSessionCatalogTransitions,
  getSessionCatalogUrl,
  normalizeRunningSessionResponse,
  normalizeSessionCatalogResponse,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./useSessionCatalog.ts");

const session = {
  id: "session-1",
  path: "/tmp/session-1.jsonl",
  cwd: "/tmp",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hello",
};

test("normalizes optional catalog arrays and rejects malformed session records", () => {
  assert.deepEqual(normalizeSessionCatalogResponse({
    sessions: [
      session,
      null,
      { ...session, id: "invalid", relation: { kind: "subagent", status: "unknown" } },
    ],
    runningSessionIds: ["session-1", "session-1", 42],
    completionNotificationSuppressedSessionIds: ["subagent-1", null, "subagent-1"],
    sessionListVersion: 7,
  }), {
    sessions: [session],
    runningSessionIds: ["session-1"],
    completionNotificationSuppressedSessionIds: ["subagent-1"],
    sessionListVersion: 7,
  });
  assert.deepEqual(normalizeSessionCatalogResponse({ sessions: [session] }).runningSessionIds, []);
  assert.equal(normalizeSessionCatalogResponse({ sessions: [session] }).sessionListVersion, null);
  assert.throws(
    () => normalizeSessionCatalogResponse({ runningSessionIds: ["session-1"] }),
    /Invalid session catalog response/,
  );
});

test("normalizes running snapshots and rejects non-object responses", () => {
  assert.deepEqual(normalizeRunningSessionResponse({
    runningSessionIds: ["session-1", "session-1", false],
    completionNotificationSuppressedSessionIds: ["subagent-1"],
    sessionListVersion: 3,
  }), {
    runningSessionIds: ["session-1"],
    completionNotificationSuppressedSessionIds: ["subagent-1"],
    sessionListVersion: 3,
  });
  assert.equal(normalizeRunningSessionResponse({}).sessionListVersion, null);
  assert.throws(() => normalizeRunningSessionResponse(null), /Invalid running session response/);
});

test("keeps force refresh routing explicit", () => {
  assert.equal(getSessionCatalogUrl(), "/api/sessions");
  assert.equal(getSessionCatalogUrl(true), "/api/sessions?force=1");
});

test("classifies background completion without notifying selected, suppressed, or subagent sessions", () => {
  assert.deepEqual(getSessionCatalogTransitions({
    previousRunningSessionIds: new Set(["done", "selected", "subagent", "suppressed"]),
    runningSessionIds: new Set(["new"]),
    selectedSessionId: "selected",
    previousSuppressedCompletionSessionIds: new Set(["suppressed"]),
    knownSubagentIds: new Set(["subagent"]),
  }), {
    completedInBackground: ["done", "subagent", "suppressed"],
    completedWithNotifications: ["done"],
    newlyRunning: ["new"],
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("catalog requester fences stale responses, aborts superseded work, and surfaces current errors", async () => {
  const requests = [];
  const fetcher = (url, init) => {
    const pending = deferred();
    requests.push({ url, init, pending });
    return pending.promise;
  };
  const requester = createSessionCatalogRequester(fetcher);
  const first = requester.request();
  const second = requester.request(true);

  assert.equal(requester.isPending(), true);
  assert.equal(requests[0].init.signal.aborted, true);
  requests[0].pending.resolve(jsonResponse({ sessions: [session] }));
  assert.equal(await first.promise, null);
  requests[1].pending.resolve(jsonResponse({ sessions: [session] }));
  assert.deepEqual((await second.promise).sessions, [session]);
  assert.equal(requester.isPending(), false);
  assert.deepEqual(requests.map((request) => request.url), ["/api/sessions", "/api/sessions?force=1"]);

  const failing = createSessionCatalogRequester(() => Promise.resolve(jsonResponse({}, 503)));
  await assert.rejects(failing.request().promise, /HTTP 503/);
});

test("catalog requester keeps pending truthful past five seconds and settles success, failure, cancellation, and supersession", async () => {
  const states = [];
  const requests = [];
  const fetcher = (url, init) => {
    const pending = deferred();
    requests.push({ url, init, pending });
    return pending.promise;
  };
  const requester = createSessionCatalogRequester(fetcher, (pending) => states.push(pending));
  const slow = requester.request(true);
  await new Promise((resolve) => setTimeout(resolve, 5100));
  assert.deepEqual(states, [true]);
  assert.equal(requester.isPending(), true);
  requests[0].pending.resolve(jsonResponse({ sessions: [session] }));
  await slow.promise;
  assert.deepEqual(states, [true, false]);

  const failingStates = [];
  const failing = createSessionCatalogRequester(
    () => Promise.resolve(jsonResponse({}, 503)),
    (pending) => failingStates.push(pending),
  );
  await assert.rejects(failing.request().promise, /HTTP 503/);
  assert.deepEqual(failingStates, [true, false]);

  const cancellationStates = [];
  const cancellable = createSessionCatalogRequester(fetcher, (pending) => cancellationStates.push(pending));
  const cancelled = cancellable.request();
  cancellable.cancel();
  assert.deepEqual(cancellationStates, [true, false]);
  requests[1].pending.resolve(jsonResponse({ sessions: [] }));
  assert.equal(await cancelled.promise, null);

  const supersessionStates = [];
  const superseded = createSessionCatalogRequester(fetcher, (pending) => supersessionStates.push(pending));
  const first = superseded.request();
  const second = superseded.request(true);
  assert.deepEqual(supersessionStates, [true, true]);
  requests[2].pending.resolve(jsonResponse({ sessions: [session] }));
  assert.equal(await first.promise, null);
  assert.deepEqual(supersessionStates, [true, true]);
  requests[3].pending.resolve(jsonResponse({ sessions: [session] }));
  assert.deepEqual((await second.promise).sessions, [session]);
  assert.deepEqual(supersessionStates, [true, true, false]);
});

test("running poller pauses and cleans up across visibility changes", async () => {
  let visible = true;
  let visibilityListener;
  let unsubscribeCount = 0;
  let scheduled = null;
  let clearedTimerCount = 0;
  const requests = [];
  const snapshots = [];
  const fetcher = (url, init) => {
    const pending = deferred();
    requests.push({ url, init, pending });
    return pending.promise;
  };
  const poller = createRunningSessionPoller({
    fetcher,
    isVisible: () => visible,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    subscribeVisibility: (listener) => {
      visibilityListener = listener;
      return () => { unsubscribeCount++; };
    },
    setTimer: (callback, delay) => {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimer: (timer) => {
      if (scheduled === timer) scheduled = null;
      clearedTimerCount++;
    },
  });

  poller.start();
  poller.start();
  assert.equal(requests.length, 1);
  visibilityListener();
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(requests.length, 2);
  requests[1].pending.resolve(jsonResponse({ runningSessionIds: ["session-1"] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(snapshots, [{ runningSessionIds: ["session-1"], completionNotificationSuppressedSessionIds: [], sessionListVersion: null }]);
  const timerAfterSecondPoll = scheduled;
  requests[0].pending.resolve(jsonResponse({ runningSessionIds: ["stale"] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled, timerAfterSecondPoll);

  visible = false;
  visibilityListener();
  assert.equal(scheduled, null);

  visible = true;
  visibilityListener();
  assert.equal(requests.length, 3);
  requests[2].pending.resolve(jsonResponse({ runningSessionIds: ["session-1"] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.delay, 2500);

  poller.stop();
  assert.equal(scheduled, null);
  assert.equal(unsubscribeCount, 1);
  assert.ok(clearedTimerCount > 0);
});

test("owns one session fetch and one visible-tab running poll", () => {
  assert.equal((source.match(/fetcher\(/g) ?? []).length, 2);
  assert.equal((source.match(/\/api\/agent\/running/g) ?? []).length, 1);
  assert.match(source, /fetcher\(getSessionCatalogUrl\(force\)/);
  assert.match(source, /fetcher\("\/api\/agent\/running"/);
  assert.doesNotMatch(source, /new EventSource/);
  assert.match(source, /document\.addEventListener\("visibilitychange", listener\)/);
  assert.match(source, /document\.visibilityState === "visible"/);
});

test("wires fenced refresh errors and the single visibility-aware poller", () => {
  assert.match(source, /if \(controller !== current\) return/);
  assert.match(source, /if \(background && requester\.isPending\(\)\)/);
  assert.match(source, /backgroundRefreshPendingRef\.current = true/);
  assert.match(source, /void refreshRef\.current\?\.\(\{ force: true, background: true \}\)/);
  assert.match(source, /ownerRefreshKey\?: number/);
  assert.match(source, /ownerGeneration\?: number/);
  assert.match(source, /ownerRefreshRequestIdRef/);
  assert.match(source, /pending: true, done: false, error: null/);
  assert.match(source, /pending: false, done: true, error: null/);
  assert.match(source, /pending: false, done: false, error: message/);
  assert.match(source, /if \(ownerRefreshKey === undefined\) return/);
  assert.match(source, /ownerRefreshRequestIdRef\.current === request\.id/);
  assert.match(source, /if \(!data \|\| !requester\.isCurrent\(request\.id\)\) return/);
  assert.match(source, /ownerRefreshRequestIdRef\.current !== null/);
  assert.match(source, /ownerRefreshGenerationRef\.current > 0/);
  assert.match(source, /generation: ownerRefreshGenerationRef\.current,[\s\S]*?pending: false,[\s\S]*?done: false,[\s\S]*?error: null/);
  assert.match(source, /sessionRequesterRef\.current\?\.cancel\(\)/);
  assert.doesNotMatch(source, /onRefreshPendingChange/);
});

test("threads the session list version through normalization and refresh", () => {
  assert.match(source, /sessionListVersion: number \| null/);
  assert.match(source, /sessionListVersionRef\.current = data\.sessionListVersion/);
  assert.match(source, /data\.sessionListVersion !== null && data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?refreshRef\.current\?\.\(\{ background: true \}\)/);
});

test("sidebar consumes the catalog and retains its shell callback boundary", () => {
  assert.match(sidebarSource, /useSessionCatalog\(\{[\s\S]*?selectedSessionId,[\s\S]*?refreshKey,[\s\S]*?ownerRefreshKey,[\s\S]*?onOwnerRefreshStateChange: onCatalogRefreshStateChange/);
  assert.doesNotMatch(sidebarSource, /\/api\/agent\/running/);
  assert.match(sidebarSource, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
  assert.match(sidebarSource, /onSessionsChange\?\.\(allSessions\)/);
  assert.match(sidebarSource, /onClick=\{\(\) => handleSelectSessionFromList\(family\.root\)\}/);
});
