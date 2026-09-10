import {
  SESSION_WALL_STORAGE_KEY,
  type SessionWallConfigV1,
  type SessionWallsStoreV1,
} from "./types";
import {
  createDefaultSessionWallsStore,
  migrateSessionWalls,
  normalizeSessionWallsStore,
  sessionWallTimestampValue,
} from "./validation";

export interface SessionWallStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): SessionWallStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseSessionWalls(raw: unknown): SessionWallsStoreV1 {
  if (typeof raw !== "string") return createDefaultSessionWallsStore();
  try {
    return migrateSessionWalls(JSON.parse(raw)) ?? createDefaultSessionWallsStore();
  } catch {
    return createDefaultSessionWallsStore();
  }
}

export function loadSessionWalls(
  storage: SessionWallStorage | null = getBrowserStorage(),
): SessionWallsStoreV1 {
  if (storage === null) return createDefaultSessionWallsStore();
  try {
    return parseSessionWalls(storage.getItem(SESSION_WALL_STORAGE_KEY));
  } catch {
    return createDefaultSessionWallsStore();
  }
}

function persistedSessionWall(wall: SessionWallConfigV1) {
  return {
    version: wall.version,
    wallId: wall.wallId,
    name: wall.name,
    layout: wall.layout,
    panes: wall.panes.map((pane) => ({
      paneId: pane.paneId,
      sessionId: pane.sessionId,
    })),
    focusedPaneId: wall.focusedPaneId,
    outerScrollTop: wall.outerScrollTop,
    updatedAt: wall.updatedAt,
  };
}

function serializeSessionWall(wall: SessionWallConfigV1): string {
  return JSON.stringify(persistedSessionWall(wall));
}

export function serializeSessionWalls(value: SessionWallsStoreV1): string {
  const store = normalizeSessionWallsStore(value);
  return JSON.stringify({
    version: store.version,
    activeWallId: store.activeWallId,
    walls: store.walls.map(persistedSessionWall),
  });
}

interface StoredSessionWalls {
  raw: string | null;
  present: boolean;
  value: SessionWallsStoreV1 | null;
}

function readStoredSessionWalls(storage: SessionWallStorage): StoredSessionWalls {
  const raw = storage.getItem(SESSION_WALL_STORAGE_KEY);
  if (raw === null) return { raw: null, present: false, value: null };
  if (typeof raw !== "string") return { raw: null, present: true, value: null };
  try {
    return { raw, present: true, value: migrateSessionWalls(JSON.parse(raw)) };
  } catch {
    return { raw, present: true, value: null };
  }
}

function chooseSessionWall(
  current: SessionWallConfigV1,
  incoming: SessionWallConfigV1,
): SessionWallConfigV1 {
  const currentRevision = sessionWallTimestampValue(current.updatedAt);
  const incomingRevision = sessionWallTimestampValue(incoming.updatedAt);
  if (incomingRevision > currentRevision) return incoming;
  if (incomingRevision < currentRevision) return current;

  const currentPayload = serializeSessionWall(current);
  const incomingPayload = serializeSessionWall(incoming);
  return incomingPayload > currentPayload ? incoming : current;
}

function mergeSessionWalls(
  current: SessionWallsStoreV1,
  incoming: SessionWallsStoreV1,
): SessionWallsStoreV1 {
  const incomingWalls = new Map(incoming.walls.map((wall) => [wall.wallId, wall]));
  const walls = current.walls.map((wall) => {
    const next = incomingWalls.get(wall.wallId);
    if (!next) return wall;
    incomingWalls.delete(wall.wallId);
    return chooseSessionWall(wall, next);
  });
  walls.push(...incomingWalls.values());
  return { version: incoming.version, activeWallId: incoming.activeWallId, walls };
}

const MAX_SAVE_ATTEMPTS = 2;

export function saveSessionWalls(
  value: SessionWallsStoreV1,
  storage: SessionWallStorage | null = getBrowserStorage(),
): boolean {
  if (storage === null) return false;
  try {
    const incoming = normalizeSessionWallsStore(value);
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const observed = readStoredSessionWalls(storage);
      if (observed.present && observed.value === null) return false;
      const merged = observed.value ? mergeSessionWalls(observed.value, incoming) : incoming;
      const serialized = serializeSessionWalls(merged);
      const latest = readStoredSessionWalls(storage);
      if (latest.raw !== observed.raw) {
        if (attempt + 1 === MAX_SAVE_ATTEMPTS) return false;
        continue;
      }
      if (serialized === latest.raw) return true;
      // ponytail: localStorage has no synchronous CAS; an async lock/API is required for a race after this check.
      storage.setItem(SESSION_WALL_STORAGE_KEY, serialized);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
