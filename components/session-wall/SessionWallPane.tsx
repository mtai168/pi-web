"use client";

import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSessionWallVisibility } from "@/hooks/useSessionWallVisibility";
import type { SessionWallLayout, SessionWallPaneConfig } from "@/lib/session-wall/types";
import type { SessionWallRuntimeTier } from "@/lib/session-wall/runtime-policy";
import { bumpSessionWallDiagnostic } from "@/lib/session-wall/diagnostics";
import { SessionWallEmptyPane } from "./SessionWallEmptyPane";
import { DEFAULT_SESSION_WALL_ERROR_LABELS, SessionWallErrorBoundary, type SessionWallErrorBoundaryLabels } from "./SessionWallErrorBoundary";

export const SESSION_WALL_PANE_STATUSES = ["empty", "ready", "loading", "stale", "unavailable", "error"] as const;
export type SessionWallPaneStatus = (typeof SESSION_WALL_PANE_STATUSES)[number];
export type SessionWallSessionStatus = Exclude<SessionWallPaneStatus, "empty">;

export interface SessionWallPaneState { status: SessionWallSessionStatus; message?: string; detail?: string; }
export interface SessionWallPaneMetadata { name?: string; subtitle?: string; project?: string; branch?: string; cwd?: string; updatedLabel?: string; running?: boolean; }
export interface SessionWallPaneLabels extends SessionWallErrorBoundaryLabels {
  emptySlot: string; selectSession: string; emptyDescription: string;
  loading: string; loadingDescription: string; stale: string; staleDescription: string;
  unavailable: string; unavailableDescription: string; error: string; errorDescription: string;
  ready: string; running: string; focused: string; transcript: string; noContent: string;
  expand: string; jumpToLatest: string; moreActions: string; cold: string; coldDescription: string;
}

export const DEFAULT_SESSION_WALL_PANE_LABELS: SessionWallPaneLabels = Object.freeze({
  ...DEFAULT_SESSION_WALL_ERROR_LABELS,
  emptySlot: "Empty slot", selectSession: "Select session", emptyDescription: "Choose a session for this pane.",
  loading: "Loading session", loadingDescription: "Session content is loading.", stale: "Session is stale", staleDescription: "This session is unavailable right now.",
  unavailable: "Session unavailable", unavailableDescription: "This session could not be found or read.", error: "Session error", errorDescription: "This pane encountered an error.",
  ready: "Ready", running: "Running", focused: "Focused", transcript: "Session transcript", noContent: "No pane content available.",
  expand: "Expand pane", jumpToLatest: "Jump to latest", moreActions: "More actions", cold: "Session not currently loaded", coldDescription: "Scroll this pane into view to load it.",
});

export interface SessionWallPaneActions {
  onRetry?: () => void; onReplace?: () => void; onRemove?: () => void;
  onExpand?: () => void; onJumpToLatest?: () => void;
}

export interface SessionWallPaneRuntimeContext {
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly runtimeKey: string;
  readonly onRequestFocus: () => void;
}

export function getSessionWallPaneRuntimeKey(
  pane: Pick<SessionWallPaneConfig, "paneId" | "sessionId" | "runtimeRevision">,
): string {
  return JSON.stringify([pane.paneId, pane.sessionId, pane.runtimeRevision ?? 0]);
}

export function getSessionWallActionMenuPosition(
  triggerRect: Pick<DOMRect, "top" | "right" | "bottom">,
  viewport: { width: number; height: number; offsetLeft?: number; offsetTop?: number },
): { top: number; left: number; width: number; maxHeight: number } | null {
  const padding = 8;
  const gap = 4;
  const minimumHeight = 48;
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null;

  const viewportLeft = viewport.offsetLeft ?? 0;
  const viewportTop = viewport.offsetTop ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const width = Math.min(180, viewport.width - padding * 2);
  if (width <= 0 || viewportBottom <= viewportTop) return null;

  const triggerTop = triggerRect.top + viewportTop;
  const triggerBottom = triggerRect.bottom + viewportTop;
  const triggerRight = triggerRect.right + viewportLeft;
  const aboveSpace = triggerTop - gap - (viewportTop + padding);
  const belowSpace = viewportBottom - padding - triggerBottom - gap;
  const placeAbove = aboveSpace >= minimumHeight && (aboveSpace >= belowSpace || belowSpace < minimumHeight);
  const availableHeight = placeAbove ? aboveSpace : belowSpace;
  const fallbackHeight = viewportBottom - viewportTop - padding * 2;
  if (availableHeight < minimumHeight && fallbackHeight < minimumHeight) return null;

  const candidateMaxHeight = Math.min(240, availableHeight >= minimumHeight ? availableHeight : fallbackHeight);
  const viewportMinTop = viewportTop + padding;
  const viewportMaxTop = viewportBottom - padding - minimumHeight;
  if (viewportMaxTop < viewportMinTop) return null;
  const candidateTop = availableHeight >= minimumHeight
    ? placeAbove ? triggerTop - gap - candidateMaxHeight : triggerBottom + gap
    : viewportMinTop;
  const top = Math.max(viewportMinTop, Math.min(candidateTop, viewportMaxTop));
  const maxHeight = Math.min(candidateMaxHeight, viewportBottom - padding - top);
  if (maxHeight < minimumHeight) return null;
  const left = Math.max(
    viewportLeft + padding,
    Math.min(triggerRight - width, viewportRight - padding - width),
  );
  return { top, left, width, maxHeight };
}

const NOOP_FOCUS = () => {};

export interface SessionWallPaneRenderContext {
  pane: SessionWallPaneConfig; runtime: SessionWallPaneRuntimeContext; metadata?: SessionWallPaneMetadata; status: SessionWallPaneStatus;
  running: boolean; focused: boolean; onRequestFocus: () => void; onHeaderStatusChange: (content: ReactNode | null) => void;
}
export interface SessionWallPaneProps extends SessionWallPaneActions {
  pane: SessionWallPaneConfig; metadata?: SessionWallPaneMetadata; state?: SessionWallPaneState;
  running?: boolean; focused?: boolean; layout?: SessionWallLayout; inOverscan?: boolean; blockingAttention?: boolean; content?: ReactNode; children?: ReactNode;
  renderContent?: (context: SessionWallPaneRenderContext) => ReactNode; footer?: ReactNode;
  renderFooter?: (context: SessionWallPaneRenderContext) => ReactNode; onFocus?: () => void;
  onSelectSession?: () => void; resetKey?: string | number | null; labels?: Partial<SessionWallPaneLabels>;
  className?: string; style?: CSSProperties;
}

export function getSessionWallPaneStatus(pane: Pick<SessionWallPaneConfig, "sessionId">, state?: SessionWallPaneState): SessionWallPaneStatus {
  return pane.sessionId === null ? "empty" : (state?.status ?? "ready");
}

export function getSessionWallPaneFrameStyle(focused: boolean): Pick<CSSProperties, "border" | "outline" | "outlineOffset"> {
  return { border: "1px solid var(--border)", outline: focused ? "2px solid var(--accent)" : "none", outlineOffset: "-2px" };
}

export function getSessionWallPaneHeadingId(paneId: string): string {
  return `session-wall-pane-heading-${encodeURIComponent(paneId)}`;
}

export function getSessionWallPaneAccessibleMetadata(metadata?: SessionWallPaneMetadata): string {
  if (!metadata) return "";
  if (metadata.subtitle?.trim()) return metadata.subtitle.trim();
  return [metadata.project, metadata.branch, metadata.cwd, metadata.updatedLabel]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" | ");
}

function getSessionWallPathBasename(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || normalized;
}

export function getSessionWallPaneSecondaryText(metadata?: SessionWallPaneMetadata): string {
  if (!metadata) return "";
  if (metadata.subtitle?.trim()) return metadata.subtitle.trim();
  return [metadata.project, metadata.cwd]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(getSessionWallPathBasename)
    .concat([metadata.branch?.trim(), metadata.updatedLabel?.trim()].filter((value): value is string => Boolean(value)))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" | ");
}

export const SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH = 512;

export function getSessionWallPaneDiagnosticText(value?: string | null): string {
  const text = typeof value === "string" ? value.trim() : "";
  const characters = Array.from(text);
  return characters.length > SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH
    ? `${characters.slice(0, SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH - 3).join("")}...`
    : text;
}

export function getSessionWallPaneStatusLabel(status: SessionWallPaneStatus, running: boolean, labels: Pick<SessionWallPaneLabels, "loading" | "stale" | "unavailable" | "error" | "running" | "ready">): string {
  if (status === "loading") return labels.loading;
  if (status === "stale") return labels.stale;
  if (status === "unavailable") return labels.unavailable;
  if (status === "error") return labels.error;
  return running ? labels.running : labels.ready;
}

export function getSessionWallPaneStateCopy(status: SessionWallPaneStatus, labels: Pick<SessionWallPaneLabels, "emptySlot" | "emptyDescription" | "loading" | "loadingDescription" | "stale" | "staleDescription" | "unavailable" | "unavailableDescription" | "error" | "errorDescription">): { title: string; description: string; role: "status" | "alert" } {
  if (status === "empty") return { title: labels.emptySlot, description: labels.emptyDescription, role: "status" };
  if (status === "loading") return { title: labels.loading, description: labels.loadingDescription, role: "status" };
  if (status === "stale") return { title: labels.stale, description: labels.staleDescription, role: "alert" };
  if (status === "unavailable") return { title: labels.unavailable, description: labels.unavailableDescription, role: "alert" };
  return { title: labels.error, description: labels.errorDescription, role: "alert" };
}

export function getSessionWallPaneColdStateCopy(
  pane: Pick<SessionWallPaneConfig, "paneId" | "sessionId">,
  title: string,
  labels: Pick<SessionWallPaneLabels, "cold" | "coldDescription">,
): { title: string; description: string } {
  const identity = pane.sessionId ? `${title} (${pane.sessionId})` : `${title} (${pane.paneId})`;
  return { title: labels.cold, description: getSessionWallPaneDiagnosticText(`${identity}: ${labels.coldDescription}`) };
}

export function shouldRenderSessionWallPaneContent(
  status: SessionWallPaneStatus,
  tier: SessionWallRuntimeTier,
): boolean {
  return status === "ready" && tier !== "cold";
}

type ActionKind = "retry" | "expand" | "latest" | "replace" | "remove";
function PaneIcon({ kind }: { kind: ActionKind }) {
  const paths = {
    retry: <><path d="M20 11a8 8 0 1 0 2 5" /><path d="M20 4v7h-7" /></>,
    expand: <><path d="M8 3H3v5M3 3l7 7M16 21h5v-5M21 21l-7-7" /></>,
    latest: <><path d="M12 5v14M6 13l6 6 6-6" /></>,
    replace: <><path d="M3 7h13" /><path d="m12 3 4 4-4 4" /><path d="M21 17H8" /><path d="m12 13-4 4 4 4" /></>,
    remove: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="m6 7 1 13h10l1-13M9 7V4h6v3" /></>,
  }[kind];
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
}

function OverflowIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>;
}

function ActionButton({ label, kind, onClick, iconOnly = false, role }: { label: string; kind: ActionKind; onClick: () => void; iconOnly?: boolean; role?: "menuitem" }) {
  return (
    <button type="button" role={role} onClick={(event) => { event.stopPropagation(); onClick(); }} title={label} aria-label={label} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: iconOnly ? 0 : 5, flex: iconOnly ? "0 0 24px" : undefined, width: iconOnly ? 24 : undefined, minHeight: iconOnly ? 24 : 27, padding: iconOnly ? 0 : "4px 9px", border: iconOnly ? 0 : "1px solid var(--border)", borderRadius: 4, background: iconOnly ? "transparent" : "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", font: "inherit", fontSize: 11 }} onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }} onMouseLeave={(event) => { event.currentTarget.style.background = iconOnly ? "transparent" : "var(--bg-panel)"; event.currentTarget.style.color = "var(--text-muted)"; }}>
      <PaneIcon kind={kind} />
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}

function PaneStateBody({ status, state, labels, onRetry, onReplace, onRemove, onSelectSession }: { status: SessionWallPaneStatus; state?: SessionWallPaneState; labels: SessionWallPaneLabels; onRetry?: () => void; onReplace?: () => void; onRemove?: () => void; onSelectSession?: () => void }) {
  if (status === "empty") return <SessionWallEmptyPane onSelect={onSelectSession} label={labels.selectSession} description={labels.emptyDescription} />;
  const copy = getSessionWallPaneStateCopy(status, labels);
  const message = getSessionWallPaneDiagnosticText(state?.message);
  const description = message || getSessionWallPaneDiagnosticText(copy.description);
  const detail = getSessionWallPaneDiagnosticText(state?.detail);
  return <div role={copy.role} aria-label={copy.title} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 7, minWidth: 0, minHeight: "100%", padding: "14px 16px", color: "var(--text-muted)" }}>
    <strong style={{ color: "var(--text)", fontSize: 12 }}>{copy.title}</strong>
    <span style={{ maxWidth: "100%", maxHeight: "4.35em", overflow: "hidden", fontSize: 11, lineHeight: 1.45, overflowWrap: "anywhere", wordBreak: "break-word" }}>{description}</span>
    {detail && <span style={{ maxWidth: "100%", maxHeight: "2.8em", overflow: "hidden", fontSize: 10, lineHeight: 1.4, color: "var(--text-dim)", overflowWrap: "anywhere", wordBreak: "break-word" }}>{detail}</span>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {onRetry && <ActionButton label={labels.retry} kind="retry" onClick={onRetry} />}
      {onReplace && <ActionButton label={labels.replace} kind="replace" onClick={onReplace} />}
      {onRemove && <ActionButton label={labels.remove} kind="remove" onClick={onRemove} />}
    </div>
  </div>;
}

function PaneColdBody({ pane, title, labels }: { pane: SessionWallPaneConfig; title: string; labels: SessionWallPaneLabels }) {
  const copy = getSessionWallPaneColdStateCopy(pane, title, labels);
  return <div role="status" aria-label={copy.title} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 7, minWidth: 0, minHeight: "100%", padding: "14px 16px", color: "var(--text-muted)" }}>
    <strong style={{ color: "var(--text)", fontSize: 12 }}>{copy.title}</strong>
    <span style={{ maxWidth: "100%", maxHeight: "4.35em", overflow: "hidden", fontSize: 11, lineHeight: 1.45, overflowWrap: "anywhere", wordBreak: "break-word" }}>{copy.description}</span>
  </div>;
}

function PaneBody({ context, status, state, labels, content, childContent, renderContent, footer, renderFooter, onRetry, onReplace, onRemove, onSelectSession, runtimeTier, pane, title }: { context: SessionWallPaneRenderContext; status: SessionWallPaneStatus; state?: SessionWallPaneState; labels: SessionWallPaneLabels; content?: ReactNode; childContent?: ReactNode; renderContent?: (context: SessionWallPaneRenderContext) => ReactNode; footer?: ReactNode; renderFooter?: (context: SessionWallPaneRenderContext) => ReactNode; onRetry?: () => void; onReplace?: () => void; onRemove?: () => void; onSelectSession?: () => void; runtimeTier: SessionWallRuntimeTier; pane: SessionWallPaneConfig; title: string }) {
  if (!shouldRenderSessionWallPaneContent(status, runtimeTier)) {
    if (status !== "ready") return <PaneStateBody status={status} state={state} labels={labels} onRetry={onRetry} onReplace={onReplace} onRemove={onRemove} onSelectSession={onSelectSession} />;
    return <PaneColdBody pane={pane} title={title} labels={labels} />;
  }
  const bodyContent = renderContent ? renderContent(context) : content !== undefined ? content : childContent;
  const footerContent = renderFooter ? renderFooter(context) : footer;
  return <>
    <div role="log" aria-label={labels.transcript} tabIndex={0} data-wall-density="true" style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "var(--wall-pane-pad, 12px 14px)", color: "var(--text)" }}>{bodyContent === undefined || bodyContent === null ? labels.noContent : bodyContent}</div>
    {footerContent !== undefined && footerContent !== null && <div style={{ flexShrink: 0, minWidth: 0, borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>{footerContent}</div>}
  </>;
}

export function SessionWallPane({ pane, metadata, state, running = false, focused = false, layout = "2x2", inOverscan = false, blockingAttention = false, content, children, renderContent, footer, renderFooter, onRetry, onReplace, onRemove, onExpand, onJumpToLatest, onFocus, onSelectSession, resetKey, labels: labelOverrides, className, style }: SessionWallPaneProps) {
  const labels = { ...DEFAULT_SESSION_WALL_PANE_LABELS, ...labelOverrides };
  const [actionsOpen, setActionsOpen] = useState(false);
  const [headerStatus, setHeaderStatus] = useState<ReactNode>(null);
  const setHeaderStatusContent = useCallback((content: ReactNode | null) => {
    setHeaderStatus(() => content);
  }, []);
  const [actionsPosition, setActionsPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const closeActions = useCallback((restoreFocus = true) => {
    setActionsOpen(false);
    setActionsPosition(null);
    if (restoreFocus) actionsTriggerRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!actionsOpen) return;
    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const trigger = actionsTriggerRef.current;
      if (!trigger) return;
      const viewport = window.visualViewport;
      const position = getSessionWallActionMenuPosition(trigger.getBoundingClientRect(), {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        offsetLeft: viewport?.offsetLeft ?? 0,
        offsetTop: viewport?.offsetTop ?? 0,
      });
      if (!position) {
        closeActions();
        return;
      }
      setActionsPosition(position);
    };
    const schedule = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [actionsOpen, closeActions]);
  useEffect(() => {
    if (!actionsOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (actionsRef.current?.contains(event.target as Node) || actionsMenuRef.current?.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : null;
      const intentionalTarget = Boolean(
        target
        && target.isConnected
        && target.closest(
          'button, a, input, select, textarea, label, summary, [contenteditable="true"], [draggable="true"], [role], [tabindex]:not([tabindex="-1"])',
        ),
      );
      closeActions(!intentionalTarget);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [actionsOpen, closeActions]);
  useEffect(() => {
    if (!actionsOpen || !actionsPosition) return;
    actionsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [actionsOpen, actionsPosition]);
  useEffect(() => {
    bumpSessionWallDiagnostic("paneMounts");
    return () => bumpSessionWallDiagnostic("paneUnmounts");
  }, []);
  const status = getSessionWallPaneStatus(pane, state);
  const visibility = useSessionWallVisibility({
    runtime: pane,
    layout,
    inOverscan,
    focused,
    blockingAttention,
  });
  const paneRunning = running || metadata?.running === true;
  const title = metadata?.name?.trim() || pane.sessionId || labels.emptySlot;
  const subtitle = getSessionWallPaneSecondaryText(metadata);
  const accessibleSubtitle = getSessionWallPaneAccessibleMetadata(metadata);
  const headingId = getSessionWallPaneHeadingId(pane.paneId);
  const metadataId = `${headingId}-metadata`;
  const requestFocus = onFocus ?? NOOP_FOCUS;
  const runtime: SessionWallPaneRuntimeContext = {
    paneId: pane.paneId,
    sessionId: pane.sessionId,
    runtimeKey: visibility.runtimeKey,
    onRequestFocus: requestFocus,
  };
  const context: SessionWallPaneRenderContext = { pane, runtime, metadata, status, running: paneRunning, focused, onRequestFocus: requestFocus, onHeaderStatusChange: setHeaderStatusContent };
  const paneStyle: CSSProperties = { ...style, ...getSessionWallPaneFrameStyle(focused), display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--bg)", color: "var(--text)" };
  const actions = onExpand ? [{ label: labels.expand, kind: "expand" as const, onClick: onExpand }] : [];
  const secondaryActions = [
    onJumpToLatest && { label: labels.jumpToLatest, kind: "latest" as const, onClick: onJumpToLatest },
    onReplace && { label: labels.replace, kind: "replace" as const, onClick: onReplace },
    onRemove && { label: labels.remove, kind: "remove" as const, onClick: onRemove },
  ].filter((action): action is { label: string; kind: "latest" | "replace" | "remove"; onClick: () => void } => Boolean(action));
  const onPaneKeyDown = (event: KeyboardEvent<HTMLElement>) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); requestFocus(); } };
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeActions();
      return;
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = -1;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    items[nextIndex]?.focus();
  };

  const actionsMenu = actionsOpen && actionsPosition && typeof document !== "undefined"
    ? createPortal(
      <div
        ref={actionsMenuRef}
        role="menu"
        aria-label={labels.moreActions}
        onKeyDown={handleMenuKeyDown}
        style={{
          position: "fixed",
          top: actionsPosition.top,
          left: actionsPosition.left,
          zIndex: 140,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          width: actionsPosition.width,
          maxHeight: actionsPosition.maxHeight,
          overflowY: "auto",
          padding: 4,
          boxSizing: "border-box",
          border: "1px solid var(--border)",
          borderRadius: 5,
          background: "var(--bg)",
          boxShadow: "0 5px 16px rgba(0,0,0,0.16)",
        }}
      >
        {secondaryActions.map((action) => <div key={action.kind} role="none"><ActionButton {...action} role="menuitem" onClick={() => { closeActions(false); action.onClick(); }} /></div>)}
      </div>,
      document.body,
    )
    : null;

  return <section ref={visibility.ref} className={className} style={paneStyle} tabIndex={0} aria-labelledby={headingId} aria-busy={status === "loading"} data-session-wall-pane="true" data-session-wall-pane-id={pane.paneId} data-session-wall-session-id={pane.sessionId ?? undefined} data-session-wall-runtime-key={runtime.runtimeKey} data-session-wall-layout={layout} data-session-wall-in-overscan={visibility.inOverscan ? "true" : "false"} data-session-wall-observed={visibility.observed ? "true" : "false"} data-session-wall-visibility={visibility.visible ? "visible" : "outside"} data-session-wall-runtime-tier={visibility.tier} data-session-wall-runtime-reason={visibility.policy.reason} aria-describedby={subtitle ? metadataId : undefined} aria-current={focused ? "true" : undefined} data-session-wall-status={status} data-session-wall-focused={focused ? "true" : "false"} onClick={requestFocus} onKeyDown={onPaneKeyDown}>
    <header style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, minWidth: 0, minHeight: 42, padding: "6px 8px 6px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}><h2 id={headingId} style={{ margin: 0, overflow: "hidden", color: "var(--text)", fontSize: 12, fontWeight: 600, lineHeight: 1.35, textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={title}>{title}</h2>{subtitle && <div id={metadataId} aria-label={accessibleSubtitle} style={{ minWidth: 0, overflow: "hidden", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.35, textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={accessibleSubtitle}>{subtitle}</div>}</div>
      {headerStatus}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, color: focused ? "var(--accent)" : "var(--text-muted)", fontSize: 10 }} aria-label={getSessionWallPaneStatusLabel(status, paneRunning, labels)}><span aria-hidden="true" style={{ width: 6, height: 6, flex: "0 0 6px", borderRadius: "50%", background: status === "error" || status === "unavailable" || status === "stale" ? "#d97706" : paneRunning ? "var(--accent)" : "var(--text-dim)" }} /><span>{getSessionWallPaneStatusLabel(status, paneRunning, labels)}</span>{focused && <span>{labels.focused}</span>}</div>
      {(actions.length > 0 || secondaryActions.length > 0) && <div ref={actionsRef} style={{ display: "flex", alignItems: "center", gap: 2, position: "relative", flexShrink: 0 }}>
        {actions.map((action) => <ActionButton key={action.kind} {...action} iconOnly />)}
        {secondaryActions.length > 0 && <>
          <button ref={actionsTriggerRef} type="button" onClick={(event) => { event.stopPropagation(); if (actionsOpen) closeActions(); else { requestFocus(); setActionsPosition(null); setActionsOpen(true); } }} onKeyDown={(event) => { if (event.key === "Escape" && actionsOpen) { event.preventDefault(); event.stopPropagation(); closeActions(); } }} aria-haspopup="menu" aria-expanded={actionsOpen} aria-label={labels.moreActions} title={labels.moreActions} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, border: 0, borderRadius: 4, background: actionsOpen ? "var(--bg-hover)" : "transparent", color: "var(--text-muted)", cursor: "pointer", font: "inherit" }}><OverflowIcon /></button>
          {actionsMenu}
        </>}
      </div>}
    </header>
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <SessionWallErrorBoundary key={runtime.runtimeKey} paneId={pane.paneId} sessionId={pane.sessionId} paneLabel={title} resetKey={resetKey ?? runtime.runtimeKey} labels={labels} onRetry={onRetry} onReplace={onReplace} onRemove={onRemove}>
        <PaneBody key={runtime.runtimeKey} context={context} status={status} state={state} labels={labels} content={content} childContent={children} renderContent={renderContent} footer={footer} renderFooter={renderFooter} onRetry={onRetry} onReplace={onReplace} onRemove={onRemove} onSelectSession={onSelectSession} runtimeTier={visibility.tier} pane={pane} title={title} />
      </SessionWallErrorBoundary>
    </div>
  </section>;
}
