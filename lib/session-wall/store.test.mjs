import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createDefaultSessionWallsStore,
  isSessionWallsStoreV1,
} = await jiti.import("./validation.ts");
const {
  loadSessionWalls,
  parseSessionWalls,
  saveSessionWalls,
  serializeSessionWalls,
} = await jiti.import("./store.ts");

class MemoryStorage {
  values = new Map();
  writes = 0;

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.writes += 1;
    this.values.set(key, value);
  }
}

class InterleavingStorage extends MemoryStorage {
  beforeNextRead = null;
  readCount = 0;

  getItem(key) {
    this.readCount += 1;
    const callback = this.readCount === 2 ? this.beforeNextRead : null;
    if (callback) this.beforeNextRead = null;
    callback?.();
    return super.getItem(key);
  }
}

function storeWithWall(wall) {
  return { version: 1, activeWallId: wall.wallId, walls: [wall] };
}

test("uses a valid in-memory default when storage is unavailable", () => {
  const store = loadSessionWalls(null);

  assert.equal(isSessionWallsStoreV1(store), true);
  assert.equal(store.walls[0].layout, "2x2");
  assert.equal(store.walls[0].panes.length, 4);
  assert.equal(saveSessionWalls(store, null), false);
});

test("malformed and future storage fall back without writing the raw value", () => {
  for (const raw of ["{", JSON.stringify({ version: 2, walls: [] })]) {
    const storage = new MemoryStorage();
    storage.values.set("pi-web:session-walls:v1", raw);

    const loaded = loadSessionWalls(storage);
    assert.equal(loaded.walls[0].layout, "2x2");
    assert.equal(storage.writes, 0);
    assert.equal(storage.getItem("pi-web:session-walls:v1"), raw);
  }

  const throwingStorage = {
    getItem() {
      throw new Error("unavailable");
    },
    setItem() {
      throw new Error("unavailable");
    },
  };
  assert.equal(loadSessionWalls(throwingStorage).walls[0].panes.length, 4);
  assert.equal(saveSessionWalls(createDefaultSessionWallsStore(), throwingStorage), false);
});

test("save fails closed on malformed or future raw storage without writing", () => {
  for (const raw of [
    "{{{not-json-raw-test-value",
    "{",
    JSON.stringify({ version: 2, walls: [] }),
  ]) {
    const storage = new MemoryStorage();
    storage.values.set("pi-web:session-walls:v1", raw);

    const loaded = loadSessionWalls(storage);
    assert.equal(saveSessionWalls(loaded, storage), false);
    assert.equal(storage.writes, 0);
    assert.equal(storage.getItem("pi-web:session-walls:v1"), raw);
  }
});

test("merges newer updates to different walls before saving", () => {
  const initial = createDefaultSessionWallsStore();
  initial.walls.push({
    ...initial.walls[0],
    wallId: "wall-secondary",
    name: "Secondary",
    panes: initial.walls[0].panes.map((pane) => ({ ...pane })),
  });
  const storage = new MemoryStorage();
  assert.equal(saveSessionWalls(initial, storage), true);

  const left = loadSessionWalls(storage);
  left.walls[0] = { ...left.walls[0], name: "Left", updatedAt: "2026-01-02T00:00:00.000Z" };
  const right = loadSessionWalls(storage);
  right.walls[1] = { ...right.walls[1], name: "Right", updatedAt: "2026-01-03T00:00:00.000Z" };

  assert.equal(saveSessionWalls(left, storage), true);
  assert.equal(saveSessionWalls(right, storage), true);
  const merged = loadSessionWalls(storage);
  assert.deepEqual(merged.walls.map(({ name }) => name), ["Left", "Right"]);
});

test("keeps a newer same-wall revision over an older stale snapshot", () => {
  const base = createDefaultSessionWallsStore().walls[0];
  const storage = new MemoryStorage();
  assert.equal(saveSessionWalls(storeWithWall(base), storage), true);

  const newer = {
    ...base,
    name: "newer",
    updatedAt: "2026-01-03T00:00:00.000Z",
  };
  const older = {
    ...base,
    name: "older",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };

  assert.equal(saveSessionWalls(storeWithWall(newer), storage), true);
  assert.equal(saveSessionWalls(storeWithWall(older), storage), true);
  assert.equal(loadSessionWalls(storage).walls[0].name, "newer");
});

test("uses a deterministic whole-wall winner for equal revisions", () => {
  const base = createDefaultSessionWallsStore().walls[0];
  const timestamp = "2026-01-02T00:00:00.000Z";
  const nameEdit = { ...base, name: "Name edit", updatedAt: timestamp };
  const paneEdit = {
    ...base,
    updatedAt: timestamp,
    panes: base.panes.map((pane, index) => (
      index === 0 ? { ...pane, sessionId: "pane-session" } : { ...pane }
    )),
  };

  function saveInOrder(first, second) {
    const storage = new MemoryStorage();
    assert.equal(saveSessionWalls(storeWithWall(first), storage), true);
    assert.equal(saveSessionWalls(storeWithWall(second), storage), true);
    return loadSessionWalls(storage);
  }

  const nameFirst = saveInOrder(nameEdit, paneEdit);
  const paneFirst = saveInOrder(paneEdit, nameEdit);
  assert.deepEqual(nameFirst, paneFirst);

  const result = serializeSessionWalls(nameFirst);
  assert.equal(
    result === serializeSessionWalls(storeWithWall(nameEdit))
      || result === serializeSessionWalls(storeWithWall(paneEdit)),
    true,
  );
});

test("normalizes invalid timestamps and never lets them beat a valid revision", () => {
  const base = createDefaultSessionWallsStore().walls[0];
  const invalid = { ...base, name: "invalid", updatedAt: "not-a-date" };
  const valid = {
    ...base,
    name: "valid",
    updatedAt: "2026-01-02T00:00:00+00:00",
  };
  const storage = new MemoryStorage();

  assert.equal(saveSessionWalls(storeWithWall(invalid), storage), true);
  assert.equal(loadSessionWalls(storage).walls[0].updatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(saveSessionWalls(storeWithWall(valid), storage), true);
  assert.equal(saveSessionWalls(storeWithWall(invalid), storage), true);
  assert.equal(loadSessionWalls(storage).walls[0].name, "valid");
  assert.equal(loadSessionWalls(storage).walls[0].updatedAt, "2026-01-02T00:00:00.000Z");
});

test("does not rewrite an identical canonical payload", () => {
  const storage = new MemoryStorage();
  const source = createDefaultSessionWallsStore();
  assert.equal(saveSessionWalls(source, storage), true);
  const writes = storage.writes;

  assert.equal(saveSessionWalls(loadSessionWalls(storage), storage), true);
  assert.equal(storage.writes, writes);
});

test("rechecks before committing an interleaved newer writer", () => {
  const storage = new InterleavingStorage();
  const base = createDefaultSessionWallsStore().walls[0];
  assert.equal(saveSessionWalls(storeWithWall(base), storage), true);

  const stale = {
    ...base,
    name: "stale",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const newer = {
    ...base,
    name: "newer",
    updatedAt: "2026-01-03T00:00:00.000Z",
  };
  storage.readCount = 0;
  storage.beforeNextRead = () => {
    assert.equal(saveSessionWalls(storeWithWall(newer), storage), true);
  };

  assert.equal(saveSessionWalls(storeWithWall(stale), storage), true);
  assert.equal(loadSessionWalls(storage).walls[0].name, "newer");
  assert.equal(storage.writes, 2);
});

test("round-trips supported fields and omits runtime-only revisions", () => {
  const source = createDefaultSessionWallsStore();
  source.activeWallId = "wall-main";
  source.walls[0] = {
    ...source.walls[0],
    wallId: "wall-main",
    name: "Main",
    layout: "2x2",
    focusedPaneId: "pane-2",
    outerScrollTop: 18.5,
    updatedAt: "2026-01-02T03:04:05.000Z",
    panes: source.walls[0].panes.map((pane, index) => ({
      ...pane,
      sessionId: index === 1 ? "stale-session" : null,
      runtimeRevision: index + 1,
    })),
  };

  const storage = new MemoryStorage();
  assert.equal(saveSessionWalls(source, storage), true);
  const serialized = storage.getItem("pi-web:session-walls:v1");
  assert.equal(serialized.includes("runtimeRevision"), false);
  assert.deepEqual(loadSessionWalls(storage), {
    version: 1,
    activeWallId: "wall-main",
    walls: [{
      version: 1,
      wallId: "wall-main",
      name: "Main",
      layout: "2x2",
      panes: [
        { paneId: "pane-1", sessionId: null },
        { paneId: "pane-2", sessionId: "stale-session" },
        { paneId: "pane-3", sessionId: null },
        { paneId: "pane-4", sessionId: null },
      ],
      focusedPaneId: "pane-2",
      outerScrollTop: 18.5,
      updatedAt: "2026-01-02T03:04:05.000Z",
    }],
  });
});

test("parsing a non-string is safe", () => {
  assert.equal(parseSessionWalls(null).walls[0].panes.length, 4);
  assert.equal(parseSessionWalls(42).walls[0].panes.length, 4);
  assert.equal(JSON.parse(serializeSessionWalls(createDefaultSessionWallsStore())).version, 1);
});

test("non-string raw storage values fall back without writing", () => {
  const storage = new MemoryStorage();
  storage.values.set("pi-web:session-walls:v1", 42);

  const loaded = loadSessionWalls(storage);
  assert.equal(loaded.walls[0].layout, "2x2");
  assert.equal(loaded.walls[0].panes.length, 4);
  assert.equal(storage.writes, 0);
  assert.equal(storage.getItem("pi-web:session-walls:v1"), 42);
});

test("stale session ids stay in their slots without substitution", () => {
  const base = createDefaultSessionWallsStore().walls[0];
  const wall = {
    ...base,
    panes: base.panes.map((pane, index) => ({
      ...pane,
      sessionId: index === 1 ? "deleted-session" : index === 2 ? "other-session" : null,
    })),
  };
  const storage = new MemoryStorage();
  assert.equal(saveSessionWalls(storeWithWall(wall), storage), true);

  const loaded = loadSessionWalls(storage);
  assert.deepEqual(
    loaded.walls[0].panes.map((pane) => pane.sessionId),
    [null, "deleted-session", "other-session", null],
  );
});

test("store never logs raw storage content or error paths", async () => {
  const source = await readFile(new URL("./store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\./);
});
