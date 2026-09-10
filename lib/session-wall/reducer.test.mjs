import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createDefaultSessionWallConfig } = await jiti.import("./validation.ts");
const {
  sessionWallReducer,
} = await jiti.import("./reducer.ts");

function action(type, values = {}) {
  return { type, updatedAt: "2026-01-01T00:00:00.000Z", ...values };
}

test("grows 4 to 8 to 12 while preserving order, then shrinks to the first four", () => {
  const four = createDefaultSessionWallConfig();
  four.panes[0].sessionId = "first";
  four.panes[3].sessionId = "fourth";
  four.focusedPaneId = "pane-4";

  const eight = sessionWallReducer(four, action("setLayout", { layout: "2x4" }));
  const twelve = sessionWallReducer(eight, action("setLayout", { layout: "2x6" }));
  const occupiedTwelve = sessionWallReducer(
    twelve,
    action("replace", { paneId: "pane-12", sessionId: "last" }),
  );
  const blockedShrink = sessionWallReducer(
    occupiedTwelve,
    action("setLayout", { layout: "2x2" }),
  );
  const backToFour = sessionWallReducer(twelve, action("setLayout", { layout: "2x2" }));

  assert.equal(eight.panes.length, 8);
  assert.equal(twelve.panes.length, 12);
  assert.equal(blockedShrink.layout, "2x6");
  assert.equal(blockedShrink.panes[11].sessionId, "last");
  assert.deepEqual(eight.panes.slice(0, 4).map(({ paneId }) => paneId), [
    "pane-1", "pane-2", "pane-3", "pane-4",
  ]);
  assert.deepEqual(twelve.panes.slice(0, 8).map(({ paneId }) => paneId), eight.panes.map(({ paneId }) => paneId));
  assert.deepEqual(backToFour.panes.map(({ paneId }) => paneId), [
    "pane-1", "pane-2", "pane-3", "pane-4",
  ]);
  assert.deepEqual(backToFour.panes.map(({ sessionId }) => sessionId), [
    "first", null, null, "fourth",
  ]);
  assert.equal(backToFour.focusedPaneId, "pane-4");
  assert.equal(four.panes.length, 4);
  assert.equal(four.updatedAt, "1970-01-01T00:00:00.000Z");
});

test("normalizes mutation timestamps before returning a changed config", () => {
  const normalized = sessionWallReducer(
    createDefaultSessionWallConfig(),
    action("add", {
      sessionId: "session",
      updatedAt: "2026-01-02T03:04:05+02:00",
    }),
  );
  const invalid = sessionWallReducer(
    createDefaultSessionWallConfig(),
    action("add", { sessionId: "session", updatedAt: "not-a-date" }),
  );

  assert.equal(normalized.updatedAt, "2026-01-02T01:04:05.000Z");
  assert.equal(invalid.updatedAt, "1970-01-01T00:00:00.000Z");
});

test("adds a session to an empty pane and rejects duplicate or invalid IDs", () => {
  const original = createDefaultSessionWallConfig();
  const added = sessionWallReducer(original, action("add", { sessionId: " stale-session " }));
  const duplicate = sessionWallReducer(added, action("add", { sessionId: "stale-session" }));
  const invalid = sessionWallReducer(added, action("add", { sessionId: " " }));

  assert.equal(added.panes[0].sessionId, "stale-session");
  assert.equal(added.panes[0].runtimeRevision, 1);
  assert.equal(added.focusedPaneId, "pane-1");
  assert.deepEqual(duplicate, added);
  assert.deepEqual(invalid, added);
  assert.equal(original.panes[0].sessionId, null);
});

test("replaces and removes a pane without changing pane identity", () => {
  const initial = sessionWallReducer(
    createDefaultSessionWallConfig(),
    action("replace", { paneId: "pane-2", sessionId: "old-session" }),
  );
  const replaced = sessionWallReducer(
    initial,
    action("replace", { paneId: "pane-2", sessionId: "new-session" }),
  );
  const removed = sessionWallReducer(
    replaced,
    action("remove", { paneId: "pane-2" }),
  );

  assert.equal(initial.panes[1].paneId, "pane-2");
  assert.equal(initial.panes[1].runtimeRevision, 1);
  assert.equal(replaced.panes[1].paneId, "pane-2");
  assert.equal(replaced.panes[1].sessionId, "new-session");
  assert.equal(replaced.panes[1].runtimeRevision, 2);
  assert.equal(removed.panes[1].paneId, "pane-2");
  assert.equal(removed.panes[1].sessionId, null);
  assert.equal(removed.panes[1].runtimeRevision, 3);
});

test("focuses occupied panes and repairs focus after removal", () => {
  let state = createDefaultSessionWallConfig();
  state = sessionWallReducer(state, action("add", { sessionId: "first" }));
  state = sessionWallReducer(state, action("replace", { paneId: "pane-2", sessionId: "second" }));
  state = sessionWallReducer(state, action("focus", { paneId: "pane-2" }));
  assert.equal(state.focusedPaneId, "pane-2");

  const invalidFocus = sessionWallReducer(state, action("focus", { paneId: "pane-3" }));
  assert.equal(invalidFocus.focusedPaneId, "pane-1");
  const removed = sessionWallReducer(invalidFocus, action("remove", { paneId: "pane-1" }));
  assert.equal(removed.focusedPaneId, "pane-2");
  const noSessions = sessionWallReducer(removed, action("remove", { paneId: "pane-2" }));
  assert.equal(noSessions.focusedPaneId, null);
});

test("saturates runtime revisions without accepting unsafe integers", () => {
  const max = createDefaultSessionWallConfig();
  max.panes[0].runtimeRevision = Number.MAX_SAFE_INTEGER;
  const saturated = sessionWallReducer(
    max,
    action("replace", { paneId: "pane-1", sessionId: "next" }),
  );
  assert.equal(saturated.panes[0].runtimeRevision, Number.MAX_SAFE_INTEGER);

  const unsafe = createDefaultSessionWallConfig();
  unsafe.panes[0].runtimeRevision = Number.MAX_SAFE_INTEGER + 1;
  const repaired = sessionWallReducer(
    unsafe,
    action("replace", { paneId: "pane-1", sessionId: "next" }),
  );
  assert.equal(repaired.panes[0].runtimeRevision, 1);
  const invalid = createDefaultSessionWallConfig();
  invalid.panes[0].runtimeRevision = Number.POSITIVE_INFINITY;
  const repairedInvalid = sessionWallReducer(
    invalid,
    action("replace", { paneId: "pane-1", sessionId: "next" }),
  );
  assert.equal(repairedInvalid.panes[0].runtimeRevision, 1);
});

test("ignores invalid layout, duplicate replacement, and unknown focus targets", () => {
  let state = createDefaultSessionWallConfig();
  state = sessionWallReducer(state, action("add", { sessionId: "same" }));
  const invalidLayout = sessionWallReducer(state, action("setLayout", { layout: "3x3" }));
  const duplicate = sessionWallReducer(
    invalidLayout,
    action("replace", { paneId: "pane-2", sessionId: "same" }),
  );
  const unknownFocus = sessionWallReducer(
    duplicate,
    action("focus", { paneId: "missing" }),
  );

  assert.equal(invalidLayout.layout, "2x2");
  assert.deepEqual(duplicate, invalidLayout);
  assert.equal(unknownFocus.focusedPaneId, "pane-1");
});
