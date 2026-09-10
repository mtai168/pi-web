import {
  SESSION_WALL_LAYOUTS,
  SESSION_WALL_SCHEMA_VERSION,
  SESSION_WALL_SLOT_COUNTS,
  type SessionWallConfigV1,
  type SessionWallLayout,
  type SessionWallPaneConfig,
  type SessionWallsStoreV1,
} from "./types";

const DEFAULT_WALL_ID = "wall-1";
const DEFAULT_WALL_NAME = "Session Wall";
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isRuntimeRevision(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}


function nextId(prefix: string, used: Set<string>, reserved: Set<string>): string {
  let index = 1;
  let id = `${prefix}-${index}`;
  while (used.has(id) || reserved.has(id)) id = `${prefix}-${++index}`;
  return id;
}

export function normalizeSessionWallTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return DEFAULT_UPDATED_AT;
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) return DEFAULT_UPDATED_AT;
  return new Date(timestamp).toISOString();
}

export function sessionWallTimestampValue(value: unknown): number {
  return Date.parse(normalizeSessionWallTimestamp(value));
}


export function isSessionWallLayout(value: unknown): value is SessionWallLayout {
  return typeof value === "string" && SESSION_WALL_LAYOUTS.includes(value as SessionWallLayout);
}

export function normalizeSessionWallLayout(value: unknown): SessionWallLayout {
  return isSessionWallLayout(value) ? value : "2x2";
}

export function createDefaultSessionWallConfig(
  wallId = DEFAULT_WALL_ID,
  name = DEFAULT_WALL_NAME,
): SessionWallConfigV1 {
  return {
    version: SESSION_WALL_SCHEMA_VERSION,
    wallId: text(wallId) ?? DEFAULT_WALL_ID,
    name: text(name) ?? DEFAULT_WALL_NAME,
    layout: "2x2",
    panes: Array.from({ length: SESSION_WALL_SLOT_COUNTS["2x2"] }, (_, index) => ({
      paneId: `pane-${index + 1}`,
      sessionId: null,
    })),
    focusedPaneId: null,
    outerScrollTop: 0,
    updatedAt: DEFAULT_UPDATED_AT,
  };
}

export function createDefaultSessionWallsStore(): SessionWallsStoreV1 {
  const wall = createDefaultSessionWallConfig();
  return {
    version: SESSION_WALL_SCHEMA_VERSION,
    activeWallId: wall.wallId,
    walls: [wall],
  };
}

export function normalizeSessionWallConfig(
  value: unknown,
  fallbackWallId = DEFAULT_WALL_ID,
  preserveRuntimeRevision = false,
): SessionWallConfigV1 {
  const record = isRecord(value) ? value : {};
  const layout = normalizeSessionWallLayout(record.layout);
  const slotCount = SESSION_WALL_SLOT_COUNTS[layout];
  const rawPanes = Array.isArray(record.panes) ? record.panes : [];
  const reservedPaneIds = new Set(
    rawPanes.map((pane) => (isRecord(pane) ? text(pane.paneId) : null)).filter(
      (paneId): paneId is string => paneId !== null,
    ),
  );
  const usedPaneIds = new Set<string>();
  const usedSessionIds = new Set<string>();
  const panes: SessionWallPaneConfig[] = [];

  for (let index = 0; index < slotCount; index += 1) {
    const source = isRecord(rawPanes[index]) ? rawPanes[index] : {};
    const requestedPaneId = text(source.paneId);
    const paneId = requestedPaneId && !usedPaneIds.has(requestedPaneId)
      ? requestedPaneId
      : nextId("pane", usedPaneIds, reservedPaneIds);
    usedPaneIds.add(paneId);

    const requestedSessionId = text(source.sessionId);
    const sessionId = requestedSessionId && !usedSessionIds.has(requestedSessionId)
      ? requestedSessionId
      : null;
    if (sessionId) usedSessionIds.add(sessionId);

    const pane: SessionWallPaneConfig = { paneId, sessionId };
    if (preserveRuntimeRevision && isRuntimeRevision(source.runtimeRevision)) {
      pane.runtimeRevision = source.runtimeRevision;
    }
    panes.push(pane);
  }

  const focusedPaneId = text(record.focusedPaneId);
  const focusIsValid = focusedPaneId !== null
    && panes.some((pane) => pane.paneId === focusedPaneId && pane.sessionId !== null);
  const firstOccupiedPane = panes.find((pane) => pane.sessionId !== null);

  return {
    version: SESSION_WALL_SCHEMA_VERSION,
    wallId: text(record.wallId) ?? text(fallbackWallId) ?? DEFAULT_WALL_ID,
    name: text(record.name) ?? DEFAULT_WALL_NAME,
    layout,
    panes,
    focusedPaneId: focusIsValid ? focusedPaneId : (firstOccupiedPane?.paneId ?? null),
    outerScrollTop: typeof record.outerScrollTop === "number"
      && Number.isFinite(record.outerScrollTop)
      && record.outerScrollTop >= 0
      ? record.outerScrollTop
      : 0,
    updatedAt: normalizeSessionWallTimestamp(record.updatedAt),
  };
}

export function normalizeSessionWallsStore(value: unknown): SessionWallsStoreV1 {
  if (!isRecord(value) || value.version !== SESSION_WALL_SCHEMA_VERSION) {
    return createDefaultSessionWallsStore();
  }

  const rawWalls = Array.isArray(value.walls) ? value.walls : [];
  const wallSources = rawWalls.length > 0 ? rawWalls : [undefined];
  const reservedWallIds = new Set(
    wallSources.map((wall) => (isRecord(wall) ? text(wall.wallId) : null)).filter(
      (wallId): wallId is string => wallId !== null,
    ),
  );
  const usedWallIds = new Set<string>();
  const walls = wallSources.map((source) => {
    const record = isRecord(source) ? source : {};
    const requestedWallId = text(record.wallId);
    const wallId = requestedWallId && !usedWallIds.has(requestedWallId)
      ? requestedWallId
      : nextId("wall", usedWallIds, reservedWallIds);
    usedWallIds.add(wallId);
    return normalizeSessionWallConfig({ ...record, wallId }, wallId);
  });
  const requestedActiveWallId = text(value.activeWallId);

  return {
    version: SESSION_WALL_SCHEMA_VERSION,
    activeWallId: requestedActiveWallId && usedWallIds.has(requestedActiveWallId)
      ? requestedActiveWallId
      : walls[0].wallId,
    walls,
  };
}

export function migrateSessionWalls(value: unknown): SessionWallsStoreV1 | null {
  if (!isRecord(value) || value.version !== SESSION_WALL_SCHEMA_VERSION) return null;
  if (Array.isArray(value.walls) && value.walls.some((wall) => (
    !isRecord(wall) || wall.version !== SESSION_WALL_SCHEMA_VERSION
  ))) return null;
  return normalizeSessionWallsStore(value);
}

export function isSessionWallConfigV1(value: unknown): value is SessionWallConfigV1 {
  if (!isRecord(value)
    || value.version !== SESSION_WALL_SCHEMA_VERSION
    || !isCanonicalText(value.wallId)
    || !isCanonicalText(value.name)
    || !isSessionWallLayout(value.layout)
    || !Array.isArray(value.panes)
    || value.panes.length !== SESSION_WALL_SLOT_COUNTS[value.layout]
    || (value.focusedPaneId !== null && !isCanonicalText(value.focusedPaneId))
    || typeof value.outerScrollTop !== "number"
    || !Number.isFinite(value.outerScrollTop)
    || value.outerScrollTop < 0
    || !isCanonicalText(value.updatedAt)
    || normalizeSessionWallTimestamp(value.updatedAt) !== value.updatedAt) {
    return false;
  }

  const focusedPaneId = value.focusedPaneId === null ? null : text(value.focusedPaneId);
  if (value.focusedPaneId !== null && focusedPaneId === null) return false;

  const paneIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const rawPane of value.panes) {
    if (!isRecord(rawPane)) return false;
    const paneId = isCanonicalText(rawPane.paneId) ? rawPane.paneId : null;
    const paneSessionId = rawPane.sessionId === null
      ? null
      : isCanonicalText(rawPane.sessionId) ? rawPane.sessionId : null;
    if (paneId === null || paneIds.has(paneId)) return false;
    if (rawPane.sessionId !== null && paneSessionId === null) return false;
    if (paneSessionId !== null && sessionIds.has(paneSessionId)) return false;
    if ("runtimeRevision" in rawPane && !isRuntimeRevision(rawPane.runtimeRevision)) return false;
    paneIds.add(paneId);
    if (paneSessionId !== null) sessionIds.add(paneSessionId);
  }

  if (focusedPaneId !== null) {
    const focusedPane = value.panes.find((pane) => (
      isRecord(pane)
      && text(pane.paneId) === focusedPaneId
      && pane.sessionId !== null
      && text(pane.sessionId) !== null
    ));
    if (!focusedPane) return false;
  }
  return true;
}

export function isSessionWallsStoreV1(value: unknown): value is SessionWallsStoreV1 {
  const activeWallId = isRecord(value) && isCanonicalText(value.activeWallId)
    ? value.activeWallId
    : null;
  if (!isRecord(value)
    || value.version !== SESSION_WALL_SCHEMA_VERSION
    || activeWallId === null
    || !Array.isArray(value.walls)
    || value.walls.length === 0) {
    return false;
  }

  const wallIds = new Set<string>();
  for (const wall of value.walls) {
    const wallId = isRecord(wall) ? text(wall.wallId) : null;
    if (!isSessionWallConfigV1(wall) || wallId === null || wallIds.has(wallId)) return false;
    wallIds.add(wallId);
  }
  return wallIds.has(activeWallId);
}
