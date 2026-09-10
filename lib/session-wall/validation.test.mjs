import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createDefaultSessionWallConfig,
  createDefaultSessionWallsStore,
  isSessionWallConfigV1,
  isSessionWallLayout,
  isSessionWallsStoreV1,
  migrateSessionWalls,
  normalizeSessionWallConfig,
  normalizeSessionWallTimestamp,
  normalizeSessionWallsStore,
} = await jiti.import("./validation.ts");

test("creates valid defaults with four empty panes", () => {
  const wall = createDefaultSessionWallConfig();
  const store = createDefaultSessionWallsStore();

  assert.equal(wall.layout, "2x2");
  assert.equal(wall.panes.length, 4);
  assert.equal(wall.focusedPaneId, null);
  assert.equal(isSessionWallConfigV1(wall), true);
  assert.equal(isSessionWallsStoreV1(store), true);
  assert.deepEqual(wall.panes.map(({ paneId }) => paneId), [
    "pane-1",
    "pane-2",
    "pane-3",
    "pane-4",
  ]);
});

test("normalizes layout, fields, slots, duplicate sessions, and focus", () => {
  const normalized = normalizeSessionWallConfig({
    version: 1,
    wallId: " ",
    name: " ",
    layout: "2x4",
    panes: [
      { paneId: "first", sessionId: " stale-session " },
      { paneId: "second", sessionId: "stale-session" },
      { paneId: "first", sessionId: "other-session" },
      { paneId: 42, sessionId: null },
    ],
    focusedPaneId: "unknown",
    outerScrollTop: Number.POSITIVE_INFINITY,
    updatedAt: "",
  });

  assert.equal(normalized.layout, "2x4");
  assert.equal(normalized.panes.length, 8);
  assert.equal(new Set(normalized.panes.map(({ paneId }) => paneId)).size, 8);
  assert.deepEqual(normalized.panes.slice(0, 4).map(({ sessionId }) => sessionId), [
    "stale-session",
    null,
    "other-session",
    null,
  ]);
  assert.equal(normalized.focusedPaneId, "first");
  assert.equal(normalized.wallId, "wall-1");
  assert.equal(normalized.name, "Session Wall");
  assert.equal(normalized.outerScrollTop, 0);
  assert.equal(normalized.updatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(isSessionWallLayout("2x6"), true);
  assert.equal(isSessionWallLayout("bad"), false);
  assert.equal(isSessionWallConfigV1(normalized), true);
});

test("canonicalizes timestamps and maps unusable values to the epoch", () => {
  assert.equal(
    normalizeSessionWallTimestamp(" 2026-01-02T03:04:05+02:00 "),
    "2026-01-02T01:04:05.000Z",
  );
  for (const value of ["", "not-a-date", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeSessionWallTimestamp(value), "1970-01-01T00:00:00.000Z");
  }

  const parsed = normalizeSessionWallConfig({
    ...createDefaultSessionWallConfig(),
    updatedAt: "2026-01-02",
  });
  assert.equal(parsed.updatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(isSessionWallConfigV1({
    ...createDefaultSessionWallConfig(),
    updatedAt: "not-a-date",
  }), false);
});

test("normalizes multiple walls and repairs active wall identity", () => {
  const normalized = normalizeSessionWallsStore({
    version: 1,
    activeWallId: "missing",
    walls: [
      { version: 1, wallId: "main", name: "Main", layout: "2x2", panes: [] },
      { version: 1, wallId: "main", name: "Second", layout: "2x6", panes: [] },
    ],
  });

  assert.deepEqual(normalized.walls.map(({ wallId }) => wallId), ["main", "wall-1"]);
  assert.equal(normalized.activeWallId, "main");
  assert.deepEqual(normalized.walls.map(({ panes }) => panes.length), [4, 12]);
  assert.equal(isSessionWallsStoreV1(normalized), true);
});

test("fails closed for unsupported versions and rejects duplicate persisted values", () => {
  assert.equal(migrateSessionWalls({ version: 2, walls: [] }), null);
  assert.equal(migrateSessionWalls({ version: 0, walls: [] }), null);
  assert.equal(migrateSessionWalls({
    version: 1,
    walls: [{ version: 2 }],
  }), null);
  assert.equal(migrateSessionWalls({
    version: 1,
    walls: [{ wallId: "missing-version" }],
  }), null);
  assert.equal(isSessionWallsStoreV1({
    version: 1,
    activeWallId: "wall-1",
    walls: [{
      ...createDefaultSessionWallConfig(),
      panes: [
        { paneId: "same", sessionId: null },
        { paneId: "same", sessionId: null },
        { paneId: "pane-3", sessionId: null },
        { paneId: "pane-4", sessionId: null },
      ],
    }],
  }), false);
  assert.equal(isSessionWallsStoreV1({
    version: 1,
    activeWallId: "wall-1",
    walls: [{
      ...createDefaultSessionWallConfig(),
      panes: [
        { paneId: "pane-1", sessionId: "same" },
        { paneId: " pane-1 ", sessionId: "same" },
        { paneId: "pane-3", sessionId: null },
        { paneId: "pane-4", sessionId: null },
      ],
    }],
  }), false);
  assert.equal(isSessionWallsStoreV1({
    version: 1,
    activeWallId: "wall-1",
    walls: [{
      ...createDefaultSessionWallConfig(),
      wallId: "wall-1",
    }, {
      ...createDefaultSessionWallConfig(" wall-1 "),
      wallId: " wall-1 ",
    }],
  }), false);
  const paddedPane = createDefaultSessionWallConfig();
  paddedPane.panes[0] = { ...paddedPane.panes[0], paneId: " pane-1 " };
  assert.equal(isSessionWallConfigV1(paddedPane), false);
  const paddedActive = {
    ...createDefaultSessionWallsStore(),
    activeWallId: " wall-1 ",
  };
  assert.equal(isSessionWallsStoreV1(paddedActive), false);
  assert.equal(isSessionWallsStoreV1(normalizeSessionWallsStore({ version: 2 })), true);
});
