"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import type { SessionWallConfigV1, SessionWallPaneConfig } from "@/lib/session-wall/types";

type IdSource = readonly string[] | ReadonlySet<string>;

export interface SessionWallProjectGroup {
  key: string;
  label: string;
  sessions: SessionInfo[];
}

export interface SessionWallPickerLabels {
  title: string;
  addTitle: string;
  replaceTitle: string;
  search: string;
  refresh: string;
  refreshFailed: string;
  refreshed: string;
  close: string;
  loading: string;
  catalogError: string;
  emptyCatalog: string;
  noResults: string;
  staleSelections: string;
  stale: string;
  staleDescription: string;
  select: string;
  replace: string;
  remove: string;
  selected: string;
  running: string;
  idle: string;
  attention: string;
  branch: string;
  modified: string;
  unknownProject: string;
  /** Optional for label-object compatibility; defaults come from DEFAULT_SESSION_WALL_PICKER_LABELS. */
  collapseGroup?: string;
  expandGroup?: string;
}

export const DEFAULT_SESSION_WALL_PICKER_LABELS: SessionWallPickerLabels = Object.freeze({
  title: "Select session", addTitle: "Add session", replaceTitle: "Replace session",
  search: "Search sessions", refresh: "Refresh sessions", refreshFailed: "Refresh failed", refreshed: "Sessions refreshed", close: "Close",
  loading: "Loading sessions...", catalogError: "Session catalog unavailable", emptyCatalog: "No sessions available",
  noResults: "No sessions match this search", staleSelections: "Stale wall selections", stale: "Stale session",
  staleDescription: "This session is no longer in the catalog.", select: "Select", replace: "Replace", remove: "Remove",
  selected: "In Wall", running: "Running", idle: "Idle", attention: "Needs attention", branch: "Branch",
  modified: "Modified", unknownProject: "Unknown project",
  collapseGroup: "Collapse group", expandGroup: "Expand group",
});

export interface SessionWallPickerProps {
  open?: boolean;
  sessions: readonly SessionInfo[];
  loading?: boolean;
  error?: string | null;
  refreshing?: boolean;
  refreshDone?: boolean;
  refreshError?: string | null;
  runningSessionIds?: IdSource;
  attentionSessionIds?: IdSource;
  config?: Pick<SessionWallConfigV1, "panes"> | null;
  /** IDs occupied outside config.panes; callers must exclude the target pane's own session ID. */
  occupiedSessionIds?: IdSource;
  mode?: "add" | "replace";
  targetPaneId?: string | null;
  labels?: Partial<SessionWallPickerLabels>;
  onRefresh?: () => void | Promise<void>;
  onRefreshError?: (error: unknown) => void | Promise<void>;
  onClose?: () => void;
  onAddSession?: (session: SessionInfo, paneId?: string) => void;
  onReplaceSession?: (paneId: string, session: SessionInfo) => void;
  onSelectSession?: (session: SessionInfo, paneId?: string) => void;
  onRemoveSession?: (paneId: string, sessionId: string) => void;
  onRequestReplace?: (paneId: string) => void;
  formatModified?: (value: string, session: SessionInfo) => string;
  className?: string;
  style?: CSSProperties;
}

function compact(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function present(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function shorten(value: string, limit = 96): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function normalizeSessionWallSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function getSessionWallProjectKey(session: Pick<SessionInfo, "cwd" | "projectRoot" | "projectKey">): string {
  return present(session.projectKey) || present(session.projectRoot) || present(session.cwd);
}

export function getSessionWallProjectLabel(session: Pick<SessionInfo, "cwd" | "projectRoot" | "projectKey">): string {
  return trimmed(session.projectRoot) || trimmed(session.cwd) || trimmed(session.projectKey) || "Unknown project";
}

export function getSessionWallSessionTitle(session: Pick<SessionInfo, "id" | "name" | "firstMessage">): string {
  return shorten(compact(session.name) || compact(session.firstMessage) || compact(session.id).slice(0, 12));
}

function searchFields(session: SessionInfo): string[] {
  return [session.name, session.firstMessage, session.projectRoot, session.cwd, session.projectKey, session.branch]
    .map((value) => normalizeSessionWallSearch(value ?? ""));
}

export function sessionWallSearchMatches(session: SessionInfo, query: string): boolean {
  const normalized = normalizeSessionWallSearch(query);
  return !normalized || searchFields(session).some((field) => field.includes(normalized));
}

export function groupSessionWallSessions(
  sessions: readonly SessionInfo[],
  query = "",
): SessionWallProjectGroup[] {
  const groups = new Map<string, SessionWallProjectGroup>();
  for (const session of sessions) {
    if (!sessionWallSearchMatches(session, query)) continue;
    const key = getSessionWallProjectKey(session) || "unknown-project";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: getSessionWallProjectLabel(session), sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}

export function getSessionWallOccupiedSessionIds(panes: readonly Pick<SessionWallPaneConfig, "sessionId">[]): Set<string> {
  return new Set(panes.flatMap((pane) => pane.sessionId ? [pane.sessionId] : []));
}

export function getSessionWallTargetSessionId(
  panes: readonly SessionWallPaneConfig[],
  targetPaneId?: string | null,
): string | null {
  return panes.find((pane) => pane.paneId === targetPaneId)?.sessionId ?? null;
}
export function getSessionWallSelectionTargetSessionId(
  mode: "add" | "replace", panes: readonly SessionWallPaneConfig[], targetPaneId: string | null | undefined,
  occupiedOutsideWall: ReadonlySet<string>,
): string | null {
  if (mode !== "replace") return null;
  const targetSessionId = getSessionWallTargetSessionId(panes, targetPaneId);
  if (targetSessionId === null || occupiedOutsideWall.has(targetSessionId)) return null;
  return panes.some((pane) => pane.paneId !== targetPaneId && pane.sessionId === targetSessionId) ? null : targetSessionId;
}
export function isSessionWallSessionSelectable(
  sessionId: string,
  occupiedSessionIds: ReadonlySet<string>,
  targetSessionId: string | null = null,
): boolean {
  return !occupiedSessionIds.has(sessionId) || sessionId === targetSessionId;
}

export interface SessionWallSelectionHandlers {
  onAddSession?: (session: SessionInfo, paneId?: string) => void;
  onReplaceSession?: (paneId: string, session: SessionInfo) => void;
  onSelectSession?: (session: SessionInfo, paneId?: string) => void;
}

export function dispatchSessionWallSessionSelection(
  session: SessionInfo,
  mode: "add" | "replace",
  targetPaneId: string | null | undefined,
  occupiedSessionIds: ReadonlySet<string>,
  targetSessionId: string | null,
  handlers: SessionWallSelectionHandlers,
): boolean {
  const hasHandler = mode === "replace"
    ? Boolean(targetPaneId && (handlers.onReplaceSession || handlers.onSelectSession))
    : Boolean(handlers.onAddSession || handlers.onSelectSession);
  if (!hasHandler || !isSessionWallSessionSelectable(session.id, occupiedSessionIds, targetSessionId)) return false;
  if (mode === "replace" && targetPaneId) {
    if (handlers.onReplaceSession) handlers.onReplaceSession(targetPaneId, session);
    else handlers.onSelectSession?.(session, targetPaneId);
  } else if (handlers.onAddSession) handlers.onAddSession(session, targetPaneId ?? undefined);
  else handlers.onSelectSession?.(session, targetPaneId ?? undefined);
  return true;
}
export function getSessionWallRefreshErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Refresh failed";
}

export async function runSessionWallRefresh(
  onRefresh: () => void | Promise<void>,
  onRefreshError?: (error: unknown) => void,
): Promise<string | null> {
  try {
    await onRefresh();
    return null;
  } catch (error) {
    const message = getSessionWallRefreshErrorMessage(error);
    try {
      await onRefreshError?.(error);
    } catch {
      // Local feedback must not turn a handled refresh failure into a rejection.
    }
    return message;
  }
}
function Icon({ kind }: { kind: "refresh" | "close" }) {
  return kind === "refresh"
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5" /><path d="M20 4v7h-7" /></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function ActionButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} style={{ minHeight: 27, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: disabled ? "var(--text-dim)" : "var(--text-muted)", cursor: disabled ? "default" : "pointer", font: "inherit", fontSize: 11, whiteSpace: "nowrap" }}>{label}</button>;
}

function StatusMessage({ role, children }: { role: "status" | "alert"; children: React.ReactNode }) {
  return <div role={role} style={{ padding: "18px 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{children}</div>;
}

export function getSessionWallGroupId(groupKey: string): string {
  return `session-wall-picker-group-${encodeURIComponent(groupKey)}`;
}

export function getSessionWallGroupCollapsed(
  groupKey: string,
  query: string,
  userExpandedKeys: ReadonlySet<string>,
  userCollapsedKeys: ReadonlySet<string>,
  defaultExpanded = false,
): boolean {
  // While searching, matching groups stay expanded unless the user collapsed
  // them; without a query, groups default to collapsed for selection and stay
  // expanded only when the user explicitly opened them (or the group carries
  // selected/running/attention sessions that must stay manageable). Explicit
  // user state always wins over the default. The query is normalized so
  // whitespace-only input follows the collapsed default.
  if (normalizeSessionWallSearch(query)) return userCollapsedKeys.has(groupKey);
  if (userExpandedKeys.has(groupKey)) return false;
  if (userCollapsedKeys.has(groupKey)) return true;
  return !defaultExpanded;
}

export function toggleSessionWallGroup(
  groupKey: string,
  query: string,
  userExpandedKeys: ReadonlySet<string>,
  userCollapsedKeys: ReadonlySet<string>,
  defaultExpanded = false,
): { userExpandedKeys: ReadonlySet<string>; userCollapsedKeys: ReadonlySet<string> } {
  const collapsed = getSessionWallGroupCollapsed(groupKey, query, userExpandedKeys, userCollapsedKeys, defaultExpanded);
  const expanded = new Set(userExpandedKeys);
  const collapsedNext = new Set(userCollapsedKeys);
  if (collapsed) {
    expanded.add(groupKey);
    collapsedNext.delete(groupKey);
  } else {
    collapsedNext.add(groupKey);
    expanded.delete(groupKey);
  }
  return { userExpandedKeys: expanded, userCollapsedKeys: collapsedNext };
}

export function SessionWallPicker({
  open = true, sessions, loading = false, error = null,
  refreshing: externalRefreshing, refreshDone: externalRefreshDone, refreshError: externalRefreshError,
  runningSessionIds, attentionSessionIds, config, occupiedSessionIds, mode = "add", targetPaneId, labels: overrides,
  onRefresh, onRefreshError, onClose, onAddSession, onReplaceSession, onSelectSession, onRemoveSession, onRequestReplace,
  formatModified = (value) => value, className, style,
}: SessionWallPickerProps) {
  const [query, setQuery] = useState("");
  const [localRefreshFailure, setLocalRefreshFailure] = useState<string | null>(null);
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const externalRefreshLifecycleProvided = externalRefreshing !== undefined
    || externalRefreshDone !== undefined
    || externalRefreshError !== undefined;
  const refreshPending = externalRefreshLifecycleProvided ? Boolean(externalRefreshing) : localRefreshing;
  const refreshDone = externalRefreshLifecycleProvided ? Boolean(externalRefreshDone) : false;
  const refreshFailure = externalRefreshLifecycleProvided
    ? externalRefreshError ?? null
    : localRefreshFailure;
  const [userExpandedKeys, setUserExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [userCollapsedKeys, setUserCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const labels = { ...DEFAULT_SESSION_WALL_PICKER_LABELS, ...overrides };
  const panes = config?.panes ?? [];
  const groups = useMemo(() => groupSessionWallSessions(sessions, query), [sessions, query]);
  const running = new Set(runningSessionIds ?? []);
  const attention = new Set(attentionSessionIds ?? []);
  const occupiedFromProps = new Set(occupiedSessionIds ?? []);
  const occupied = new Set([...getSessionWallOccupiedSessionIds(panes), ...occupiedFromProps]);
  const selectionTargetSessionId = getSessionWallSelectionTargetSessionId(mode, panes, targetPaneId, occupiedFromProps);
  const occupiedForSelection = new Set(occupied);
  if (selectionTargetSessionId) occupiedForSelection.delete(selectionTargetSessionId);
  const canSelect = mode === "replace"
    ? Boolean(targetPaneId && (onReplaceSession || onSelectSession))
    : Boolean(onAddSession || onSelectSession);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const stalePanes = !loading && !error && !refreshFailure
    ? panes.filter((pane) => pane.sessionId !== null && !sessionIds.has(pane.sessionId))
    : [];
  const paneIdsBySession = new Map<string, string[]>();
  for (const pane of panes) {
    if (pane.sessionId) paneIdsBySession.set(pane.sessionId, [...(paneIdsBySession.get(pane.sessionId) ?? []), pane.paneId]);
  }

  if (!open) return null;

  const choose = (session: SessionInfo) => {
    dispatchSessionWallSessionSelection(session, mode, targetPaneId, occupiedForSelection, selectionTargetSessionId, {
      onAddSession, onReplaceSession, onSelectSession,
    });
  };
  const toggleGroup = (groupKey: string, defaultExpanded: boolean) => {
    const next = toggleSessionWallGroup(groupKey, query, userExpandedKeys, userCollapsedKeys, defaultExpanded);
    setUserExpandedKeys(next.userExpandedKeys);
    setUserCollapsedKeys(next.userCollapsedKeys);
  };
  const refresh = async () => {
    if (!onRefresh || loading || refreshPending) return;
    if (externalRefreshLifecycleProvided) {
      await runSessionWallRefresh(onRefresh, onRefreshError);
      return;
    }
    setLocalRefreshing(true);
    setLocalRefreshFailure(null);
    try {
      const failure = await runSessionWallRefresh(onRefresh, onRefreshError);
      setLocalRefreshFailure(failure);
    } finally {
      setLocalRefreshing(false);
    }
  };
  const title = mode === "replace" ? labels.replaceTitle : labels.addTitle;
  let catalogBody: ReactNode;
  if (error && sessions.length === 0) {
    catalogBody = <StatusMessage role="alert"><strong>{labels.catalogError}</strong><div>{error}</div><div style={{ marginTop: 8 }}><ActionButton label={labels.refresh} onClick={refresh} disabled={!onRefresh || refreshPending} /></div></StatusMessage>;
  } else if ((loading || refreshPending) && sessions.length === 0) {
    catalogBody = <StatusMessage role="status">{labels.loading}</StatusMessage>;
  } else if (sessions.length === 0) {
    catalogBody = <StatusMessage role="status">{labels.emptyCatalog}</StatusMessage>;
  } else if (groups.length === 0) {
    catalogBody = <StatusMessage role="status">{labels.noResults}</StatusMessage>;
  } else {
    catalogBody = groups.map((group) => {
      const groupLabel = group.label === "Unknown project" ? labels.unknownProject : group.label;
      // Groups holding wall selections or running/attention sessions stay
      // expanded by default so management actions remain reachable.
      const defaultExpanded = group.sessions.some((session) => occupied.has(session.id) || running.has(session.id) || attention.has(session.id));
      const collapsed = getSessionWallGroupCollapsed(group.key, query, userExpandedKeys, userCollapsedKeys, defaultExpanded);
      const groupId = getSessionWallGroupId(group.key);
      const expandLabel = labels.expandGroup ?? DEFAULT_SESSION_WALL_PICKER_LABELS.expandGroup;
      const collapseLabel = labels.collapseGroup ?? DEFAULT_SESSION_WALL_PICKER_LABELS.collapseGroup;
      return (
        <section key={group.key} aria-label={groupLabel} style={{ minWidth: 0, borderBottom: "1px solid var(--border)" }}>
          <h3 style={{ margin: 0 }}>
            <button type="button" onClick={() => toggleGroup(group.key, defaultExpanded)} aria-expanded={!collapsed} aria-controls={collapsed ? undefined : groupId} title={collapsed ? `${expandLabel}: ${groupLabel}` : `${collapseLabel}: ${groupLabel}`} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0, padding: "8px 12px 5px", border: 0, background: "none", color: "var(--text-dim)", cursor: "pointer", font: "inherit", textAlign: "left" }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.12s" }}><polyline points="6 9 12 15 18 9" /></svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, fontWeight: 650, textTransform: "uppercase" }} title={group.label}>{groupLabel}</span>
              <span style={{ flexShrink: 0, marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{group.sessions.length}</span>
            </button>
          </h3>
          {!collapsed && <div id={groupId}>{group.sessions.map((session) => {
            const selectedPaneIds = paneIdsBySession.get(session.id) ?? [];
            const selected = occupied.has(session.id);
            const selectable = canSelect && isSessionWallSessionSelectable(session.id, occupiedForSelection, selectionTargetSessionId);
            const state = running.has(session.id) ? labels.running : labels.idle;
            const status = attention.has(session.id) ? `${state} | ${labels.attention}` : state;
            const sessionTitle = getSessionWallSessionTitle(session);
            const branch = compact(session.branch);
            return <div key={session.id} style={{ display: "flex", alignItems: "stretch", gap: 4, minWidth: 0, padding: "4px 8px", borderTop: "1px solid var(--border)" }} data-session-id={session.id}>
              <button type="button" onClick={() => choose(session)} disabled={!selectable} aria-disabled={!selectable} aria-pressed={selected} aria-label={`${sessionTitle}: ${status}${selected ? `, ${labels.selected}` : ""}`} title={selectable ? `${labels.select}: ${sessionTitle}` : labels.selected} style={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", border: 0, background: selected ? "var(--bg-selected)" : "transparent", color: selectable ? "var(--text)" : "var(--text-muted)", cursor: selectable ? "pointer" : "default", font: "inherit", textAlign: "left" }}>
                <span style={{ minWidth: 0, flex: "1 1 auto" }}><span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: selected ? 600 : 500 }} title={sessionTitle}>{sessionTitle}</span><span style={{ display: "block", marginTop: 2, minWidth: 0, overflowWrap: "anywhere", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{branch ? `${labels.branch}: ${branch} | ` : ""}{labels.modified}: {formatModified(session.modified, session)}</span></span>
                <span style={{ flexShrink: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: attention.has(session.id) ? "var(--accent)" : "var(--text-muted)", fontSize: 10 }} title={status}>{status}</span>
              </button>
              {selectedPaneIds.map((paneId) => onRemoveSession && <ActionButton key={paneId} label={`${labels.remove} ${paneId}`} onClick={() => onRemoveSession(paneId, session.id)} />)}
            </div>;
          })}</div>}
        </section>
      );
    });
  }
  const panelStyle: CSSProperties = { ...style, width: "min(680px, calc(100vw - 24px))", maxHeight: "min(760px, calc(100dvh - 24px))", display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" };

  return <div role="dialog" aria-modal="true" aria-label={title} className={className} style={panelStyle} data-session-wall-picker="true" aria-busy={loading || refreshPending || undefined} onKeyDown={(event) => {
    if (event.key === "Escape" && onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }}>
    <style>{`[data-session-wall-picker] button:focus-visible,[data-session-wall-picker] input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`}</style>
    <header style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
      <h2 style={{ flex: 1, minWidth: 0, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14, fontWeight: 650 }}>{title}</h2>
      {onRefresh && <button type="button" onClick={refresh} disabled={loading || refreshPending} title={labels.refresh} aria-label={labels.refresh} style={{ width: 28, height: 28, display: "grid", placeItems: "center", flexShrink: 0, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: loading || refreshPending ? "default" : "pointer" }}><Icon kind="refresh" /></button>}
      {onClose && <button type="button" onClick={onClose} title={labels.close} aria-label={labels.close} style={{ width: 28, height: 28, display: "grid", placeItems: "center", flexShrink: 0, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}><Icon kind="close" /></button>}
    </header>
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={labels.search} aria-label={labels.search} autoFocus autoComplete="off" spellCheck={false} style={{ width: "100%", minWidth: 0, height: 32, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 12 }} />
      {loading || refreshPending ? <span role="status" style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>{labels.loading}</span> : refreshDone && !refreshFailure && <span role="status" style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>{labels.refreshed}</span>}
    </div>
    {refreshFailure && <StatusMessage role="alert"><strong>{labels.refreshFailed}</strong><div>{refreshFailure}</div></StatusMessage>}
    <div style={{ minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
      {error && sessions.length > 0 && <StatusMessage role="alert"><strong>{labels.catalogError}</strong><div>{error}</div></StatusMessage>}
      {catalogBody}
      {!loading && !refreshPending && !error && !refreshFailure && stalePanes.length > 0 && <section aria-label={labels.staleSelections} style={{ minWidth: 0, borderBottom: "1px solid var(--border)" }}><h3 style={{ margin: 0, padding: "8px 12px 5px", color: "var(--text-dim)", fontSize: 10, fontWeight: 650, textTransform: "uppercase" }}>{labels.staleSelections}</h3>{stalePanes.map((pane) => <div key={pane.paneId} role="alert" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "8px 12px", borderTop: "1px solid var(--border)" }}><span style={{ minWidth: 0, flex: "1 1 auto", overflowWrap: "anywhere", color: "var(--text-muted)", fontSize: 11 }}><strong style={{ color: "var(--text)" }}>{labels.stale}</strong> <span>{pane.sessionId}</span><span style={{ display: "block", marginTop: 2, color: "var(--text-dim)" }}>{labels.staleDescription} ({pane.paneId})</span></span>{onRequestReplace && <ActionButton label={labels.replace} onClick={() => onRequestReplace(pane.paneId)} />}{onRemoveSession && <ActionButton label={labels.remove} onClick={() => onRemoveSession(pane.paneId, pane.sessionId!)} />}</div>)}</section>}
    </div>
  </div>;
}
