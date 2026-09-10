import {
  SESSION_WALL_SLOT_COUNTS,
  type SessionWallConfigV1,
  type SessionWallPaneConfig,
} from "./types";
import {
  isSessionWallLayout,
  normalizeSessionWallConfig,
  normalizeSessionWallTimestamp,
} from "./validation";

export type SessionWallAction =
  | { type: "setLayout"; layout: unknown; updatedAt?: string }
  | { type: "add"; sessionId: unknown; updatedAt?: string }
  | { type: "replace"; paneId: unknown; sessionId: unknown; updatedAt?: string }
  | { type: "remove"; paneId: unknown; updatedAt?: string }
  | { type: "focus"; paneId: unknown; updatedAt?: string };

function sessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function revision(value: unknown): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && Number.isFinite(value)
    && value >= 0
    ? value
    : 0;
}

function bumpRevision(value: unknown): number {
  return Math.min(Number.MAX_SAFE_INTEGER, revision(value) + 1);
}

function nextPaneId(panes: SessionWallPaneConfig[]): string {
  const used = new Set(panes.map((pane) => pane.paneId));
  let index = 1;
  while (used.has(`pane-${index}`)) index += 1;
  return `pane-${index}`;
}

function normalizeForReducer(config: SessionWallConfigV1): SessionWallConfigV1 {
  return normalizeSessionWallConfig(config, config.wallId, true);
}

function finish(
  config: SessionWallConfigV1,
  changes: Partial<SessionWallConfigV1>,
  updatedAt: unknown,
): SessionWallConfigV1 {
  const timestamp = updatedAt === undefined
    ? config.updatedAt
    : normalizeSessionWallTimestamp(updatedAt);
  return normalizeSessionWallConfig({ ...config, ...changes, updatedAt: timestamp }, config.wallId, true);
}

export function setSessionWallLayout(
  config: SessionWallConfigV1,
  layout: unknown,
  updatedAt?: string,
): SessionWallConfigV1 {
  const current = normalizeForReducer(config);
  if (!isSessionWallLayout(layout) || layout === current.layout) return current;

  const slotCount = SESSION_WALL_SLOT_COUNTS[layout];
  if (slotCount < current.panes.length
    && current.panes.slice(slotCount).some((pane) => pane.sessionId !== null)) {
    return current;
  }
  const panes = current.panes.slice(0, slotCount);
  while (panes.length < slotCount) {
    panes.push({ paneId: nextPaneId(panes), sessionId: null });
  }
  return finish(current, { layout, panes }, updatedAt);
}

export function addSessionWallSession(
  config: SessionWallConfigV1,
  value: unknown,
  updatedAt?: string,
): SessionWallConfigV1 {
  const current = normalizeForReducer(config);
  const nextSessionId = sessionId(value);
  if (!nextSessionId || current.panes.some((pane) => pane.sessionId === nextSessionId)) return current;

  const index = current.panes.findIndex((pane) => pane.sessionId === null);
  if (index < 0) return current;
  const panes = current.panes.map((pane, paneIndex) => (
    paneIndex === index
      ? { ...pane, sessionId: nextSessionId, runtimeRevision: bumpRevision(pane.runtimeRevision) }
      : pane
  ));
  return finish(current, { panes }, updatedAt);
}

export function replaceSessionWallPane(
  config: SessionWallConfigV1,
  paneIdValue: unknown,
  value: unknown,
  updatedAt?: string,
): SessionWallConfigV1 {
  const current = normalizeForReducer(config);
  const paneId = sessionId(paneIdValue);
  const index = paneId === null ? -1 : current.panes.findIndex((pane) => pane.paneId === paneId);
  if (index < 0) return current;

  const nextSessionId = sessionId(value);
  if (nextSessionId && current.panes.some((pane, paneIndex) => (
    paneIndex !== index && pane.sessionId === nextSessionId
  ))) return current;

  const panes = current.panes.map((pane, paneIndex) => (
    paneIndex === index
      ? { ...pane, sessionId: nextSessionId, runtimeRevision: bumpRevision(pane.runtimeRevision) }
      : pane
  ));
  return finish(current, { panes }, updatedAt);
}

export function removeSessionWallPane(
  config: SessionWallConfigV1,
  paneIdValue: unknown,
  updatedAt?: string,
): SessionWallConfigV1 {
  const current = normalizeForReducer(config);
  const paneId = sessionId(paneIdValue);
  const index = paneId === null ? -1 : current.panes.findIndex((pane) => pane.paneId === paneId);
  if (index < 0 || current.panes[index].sessionId === null) return current;

  const panes = current.panes.map((pane, paneIndex) => (
    paneIndex === index
      ? { ...pane, sessionId: null, runtimeRevision: bumpRevision(pane.runtimeRevision) }
      : pane
  ));
  return finish(current, { panes }, updatedAt);
}

export function focusSessionWallPane(
  config: SessionWallConfigV1,
  paneIdValue: unknown,
  updatedAt?: string,
): SessionWallConfigV1 {
  const current = normalizeForReducer(config);
  const paneId = sessionId(paneIdValue);
  const target = paneId === null
    ? undefined
    : current.panes.find((pane) => pane.paneId === paneId && pane.sessionId !== null);
  const fallback = current.panes.find((pane) => pane.sessionId !== null);
  const focusedPaneId = target?.paneId ?? fallback?.paneId ?? null;
  if (focusedPaneId === current.focusedPaneId) return current;
  return finish(current, { focusedPaneId }, updatedAt);
}

export function sessionWallReducer(
  config: SessionWallConfigV1,
  action: SessionWallAction,
): SessionWallConfigV1 {
  switch (action.type) {
    case "setLayout":
      return setSessionWallLayout(config, action.layout, action.updatedAt);
    case "add":
      return addSessionWallSession(config, action.sessionId, action.updatedAt);
    case "replace":
      return replaceSessionWallPane(config, action.paneId, action.sessionId, action.updatedAt);
    case "remove":
      return removeSessionWallPane(config, action.paneId, action.updatedAt);
    case "focus":
      return focusSessionWallPane(config, action.paneId, action.updatedAt);
    default:
      return normalizeForReducer(config);
  }
}
