import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const {
  clearSessionAction,
  focusSessionAction,
  getFocusedSessionAction,
  invokeFocusedSessionAction,
  isSessionActionRoutingEnabled,
  registerSessionAction,
  resetSessionActions,
} = await createJiti(import.meta.url).import("./focus-actions.ts");

afterEach(() => resetSessionActions());

function action(sessionId, calls) {
  return { sessionId, abort: () => calls.push(sessionId) };
}

test("registrations carry session identity and unique generations", () => {
  const first = registerSessionAction(action("session-a", []));
  const second = registerSessionAction(action("session-b", []));

  assert.equal(first.sessionId, "session-a");
  assert.equal(typeof first.generation, "number");
  assert.ok(second.generation > first.generation);
  assert.equal(isSessionActionRoutingEnabled(), true);
});

test("registration order does not select a focused action", () => {
  const calls = [];
  registerSessionAction(action("session-a", calls));
  registerSessionAction(action("session-b", calls));

  assert.equal(invokeFocusedSessionAction(), false);
  assert.deepEqual(calls, []);
  assert.equal(getFocusedSessionAction(), null);
});

test("explicit focus replacement dispatches only the selected session", () => {
  const calls = [];
  const first = registerSessionAction(action("session-a", calls));
  const second = registerSessionAction(action("session-b", calls));

  assert.equal(focusSessionAction(first), true);
  assert.equal(invokeFocusedSessionAction(), true);
  assert.deepEqual(calls, ["session-a"]);

  assert.equal(focusSessionAction(second), true);
  assert.equal(invokeFocusedSessionAction(), true);
  assert.deepEqual(calls, ["session-a", "session-b"]);
  assert.equal(getFocusedSessionAction().sessionId, "session-b");
});

test("stale duplicate cleanup cannot remove the newer registration", () => {
  const calls = [];
  const stale = registerSessionAction(action("session-a", calls));
  const current = registerSessionAction(action("session-a", calls));
  assert.equal(focusSessionAction(current), true);

  assert.equal(clearSessionAction(stale), true);
  assert.equal(focusSessionAction(stale), false);
  assert.equal(invokeFocusedSessionAction(), true);
  assert.deepEqual(calls, ["session-a"]);
  assert.equal(getFocusedSessionAction().generation, current.generation);
});

test("clearing a focused registration cannot invoke it after cleanup", () => {
  const calls = [];
  const focused = registerSessionAction(action("session-a", calls));
  const other = registerSessionAction(action("session-b", calls));
  focusSessionAction(focused);

  assert.equal(clearSessionAction(focused), true);
  assert.equal(invokeFocusedSessionAction(), false);
  assert.deepEqual(calls, []);
  assert.equal(getFocusedSessionAction(), null);
  assert.equal(isSessionActionRoutingEnabled(), true);

  assert.equal(focusSessionAction(other), true);
  assert.equal(invokeFocusedSessionAction(), true);
  assert.deepEqual(calls, ["session-b"]);
});

test("clearing the last registration disables focused routing", () => {
  const registration = registerSessionAction(action("session-a", []));
  focusSessionAction(registration);

  assert.equal(clearSessionAction(registration), true);
  assert.equal(clearSessionAction(registration), false);
  assert.equal(invokeFocusedSessionAction(), false);
  assert.equal(getFocusedSessionAction(), null);
  assert.equal(isSessionActionRoutingEnabled(), false);
});

test("focused synchronous callback failures stay inside invocation", () => {
  const registration = registerSessionAction({
    sessionId: "session-a",
    abort: () => { throw new Error("abort failed"); },
  });
  focusSessionAction(registration);

  assert.doesNotThrow(() => {
    assert.equal(invokeFocusedSessionAction(), true);
  });
});

test("focused promise rejections do not become unhandled rejections", async () => {
  const registration = registerSessionAction({
    sessionId: "session-a",
    abort: () => Promise.reject(new Error("abort failed")),
  });
  focusSessionAction(registration);
  let unhandledReason;
  const onUnhandled = (reason) => { unhandledReason = reason; };
  process.on("unhandledRejection", onUnhandled);

  try {
    assert.equal(invokeFocusedSessionAction(), true);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(unhandledReason, undefined);
});

test("reset invalidates old registrations and exits focused routing", () => {
  const registration = registerSessionAction(action("session-a", []));
  assert.equal(focusSessionAction(registration), true);

  resetSessionActions();

  assert.equal(isSessionActionRoutingEnabled(), false);
  assert.equal(invokeFocusedSessionAction(), false);
  assert.equal(focusSessionAction(registration), false);
  assert.equal(clearSessionAction(registration), false);
});
