"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  parseBrainStatus,
  type BrainStatus,
  type BrainStatusField,
  type BrainStatusSnapshot,
} from "@/lib/sausage-session-terminal/brain-status";

export type BrainRuntimeState = "running" | "idle" | "error" | "unknown";

export interface BrainStatusSummaryProps {
  stableFinalAnswer: string | null;
  /** Epoch milliseconds, matching the parser's sourceMessageTimestamp. */
  sourceMessageTimestamp?: number | null;
  runtimeState: BrainRuntimeState;
  streaming?: boolean;
  previousStableSnapshot?: BrainStatusSnapshot | null;
  /** A retained snapshot is usable only when this matches sessionId. */
  previousStableSnapshotSessionId?: string | null;
  sessionId: string;
  currentSessionId: string | null;
  snapshotStale?: boolean;
  now?: number;
}

export interface BrainStatusPresentation {
  snapshot: BrainStatusSnapshot | null;
  runtimeState: BrainRuntimeState;
  displayRuntimeState: BrainRuntimeState;
  streaming: boolean;
  stale: boolean;
  sessionIsCurrent: boolean;
}

export const BRAIN_RUNTIME_FALLBACK_LABELS: Readonly<Record<BrainRuntimeState, string>> = Object.freeze({
  running: "RUNNING - No trusted Brain status",
  idle: "IDLE - No trusted Brain status",
  error: "ERROR - Brain status unavailable",
  unknown: "UNKNOWN - Brain status unavailable",
});

const STATUS_DESCRIPTIONS: Record<BrainStatus, string> = {
  DISPATCHED: "New hands dispatched",
  WAITING_FOR_HANDS: "Waiting for hands",
  BLOCKED_OWNER: "Owner attention needed",
  MILESTONE_COMPLETE: "Milestone complete",
};

const STATUS_DESCRIPTION_KEYS: Record<BrainStatus, string> = {
  DISPATCHED: "brainStatus.description.dispatched",
  WAITING_FOR_HANDS: "brainStatus.description.waiting",
  BLOCKED_OWNER: "brainStatus.description.blocked",
  MILESTONE_COMPLETE: "brainStatus.description.complete",
};

const RUNTIME_STATE_KEYS: Record<BrainRuntimeState, string> = {
  running: "brainStatus.runtime.running",
  idle: "brainStatus.runtime.idle",
  error: "brainStatus.runtime.error",
  unknown: "brainStatus.runtime.unknown",
};

const RUNTIME_FALLBACK_KEYS: Record<BrainRuntimeState, string> = {
  running: "brainStatus.fallback.running",
  idle: "brainStatus.fallback.idle",
  error: "brainStatus.fallback.error",
  unknown: "brainStatus.fallback.unknown",
};

const MAX_MILESTONE_DISPLAY_LENGTH = 2048;
type Translate = (key: string, params?: Record<string, string | number>) => string;

function localized(t: Translate, key: string, fallback: string, params?: Record<string, string | number>): string {
  const translated = t(key, params);
  if (translated !== key) return translated;
  return fallback.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params?.[name];
    return value === undefined ? token : String(value);
  });
}

export function getBrainRuntimeFallbackLabel(
  runtimeState: BrainRuntimeState,
  streaming = false,
): string {
  return BRAIN_RUNTIME_FALLBACK_LABELS[streaming ? "running" : runtimeState];
}

function getLocalizedRuntimeFallbackLabel(runtimeState: BrainRuntimeState, t: Translate): string {
  return localized(t, RUNTIME_FALLBACK_KEYS[runtimeState], BRAIN_RUNTIME_FALLBACK_LABELS[runtimeState]);
}

function getLocalizedAgeLabel(timestampMs: number | null | undefined, nowMs: number | undefined, t: Translate): string | null {
  const age = formatBrainStatusAge(timestampMs, nowMs);
  if (!age) return null;
  if (age === "just now") return localized(t, "brainStatus.age.justNow", age);
  const match = /^(\d+)([mhd]) ago$/.exec(age);
  if (!match) return age;
  const count = Number(match[1]);
  const key = match[2] === "m"
    ? "brainStatus.age.minutes"
    : match[2] === "h"
      ? "brainStatus.age.hours"
      : "brainStatus.age.days";
  return localized(t, key, age, { count });
}

export function getBrainStatusPresentation({
  stableFinalAnswer,
  sourceMessageTimestamp = null,
  runtimeState,
  streaming = false,
  previousStableSnapshot = null,
  previousStableSnapshotSessionId = null,
  sessionId,
  currentSessionId,
  snapshotStale = false,
}: BrainStatusSummaryProps): BrainStatusPresentation {
  const sessionIsCurrent = currentSessionId === sessionId;
  const snapshot = streaming
    ? sessionIsCurrent && previousStableSnapshotSessionId === sessionId ? previousStableSnapshot : null
    : parseBrainStatus(stableFinalAnswer, sourceMessageTimestamp);
  return {
    snapshot,
    runtimeState,
    displayRuntimeState: streaming ? "running" : runtimeState,
    streaming,
    stale: snapshotStale || !sessionIsCurrent,
    sessionIsCurrent,
  };
}

export function formatBrainStatusAge(timestampMs: number | null | undefined, nowMs = Date.now()): string | null {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || timestampMs > nowMs) return null;
  const seconds = Math.floor((nowMs - timestampMs) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatusIcon({ status }: { status: BrainStatus | null }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {status === "DISPATCHED" && <><path d="M4 12h14" /><path d="m13 6 6 6-6 6" /></>}
      {status === "WAITING_FOR_HANDS" && <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>}
      {status === "BLOCKED_OWNER" && <><path d="m12 4 9 16H3L12 4Z" /><path d="M12 9v5" /><path d="M12 17h.01" /></>}
      {status === "MILESTONE_COMPLETE" && <><circle cx="12" cy="12" r="8.5" /><path d="m8 12 2.5 2.5L16 9" /></>}
      {status === null && <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v5" /><path d="M12 16h.01" /></>}
    </svg>
  );
}

function hasFieldDiagnostic(snapshot: BrainStatusSnapshot, field: BrainStatusField): boolean {
  return snapshot.diagnostics.some((diagnostic) => diagnostic.field === field);
}

function getBlockerLabel(snapshot: BrainStatusSnapshot, unknownLabel: string, noneLabel: string): string {
  if (snapshot.blocker !== null) return snapshot.blocker;
  if (snapshot.status === "BLOCKED_OWNER" || hasFieldDiagnostic(snapshot, "blocker")) return unknownLabel;
  return noneLabel;
}

function DetailRow({
  label,
  value,
  title,
  valueStyle,
}: {
  label: string;
  value: string | number;
  title?: string;
  valueStyle?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0, lineHeight: 1.4 }}>
      <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{label}</span>
      <span title={title} style={{ minWidth: 0, color: "var(--text-muted)", ...valueStyle }}>{value}</span>
    </div>
  );
}

function StatusFooter({ snapshot, t }: { snapshot: BrainStatusSnapshot; t: Translate }) {
  const diagnostics = snapshot.diagnostics.map(({ message }) => message).join("; ");
  const milestoneChars = snapshot.milestone === null ? [] : Array.from(snapshot.milestone);
  const milestone = snapshot.milestone === null ? null : milestoneChars.slice(0, MAX_MILESTONE_DISPLAY_LENGTH).join("");
  const milestoneTruncated = milestoneChars.length > MAX_MILESTONE_DISPLAY_LENGTH;
  const unknown = localized(t, "brainStatus.unknown", "unknown");
  return (
    <footer
      aria-label={localized(t, "brainStatus.details", "Brain status details")}
      style={{ maxHeight: 104, minWidth: 0, overflowY: "auto", padding: "6px 9px", background: "var(--bg-panel)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}
    >
      <DetailRow
        label={localized(t, "brainStatus.milestone", "milestone:")}
        value={milestone ?? unknown}
        title={milestone ?? undefined}
        valueStyle={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      />
      {milestoneTruncated && <div role="note" data-brain-milestone-truncated="true" style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>{localized(t, "brainStatus.milestoneTruncated", "milestone truncated for display")}</div>}
      <DetailRow
        label={localized(t, "brainStatus.blocker", "blocker:")}
        value={getBlockerLabel(snapshot, unknown, localized(t, "brainStatus.none", "none"))}
        title={snapshot.blocker ?? undefined}
        valueStyle={{ flex: "1 1 auto", maxHeight: "3.2em", overflowY: "auto", overflowWrap: "anywhere", wordBreak: "break-word" }}
      />
      <DetailRow
        label={localized(t, "brainStatus.newDispatches", "new dispatches:")}
        value={snapshot.newDispatches ?? unknown}
        valueStyle={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
      />
      {snapshot.diagnostics.length > 0 && (
        <div
          role="note"
          data-brain-diagnostics={snapshot.diagnostics.length}
          aria-label={`${localized(t, "brainStatus.parserDiagnosticsAria", "Parser diagnostics")}: ${diagnostics}`}
          title={diagnostics}
          style={{ marginTop: 3, color: "var(--text-dim)", overflowWrap: "anywhere" }}
        >
          {localized(t, "brainStatus.parserDiagnostics", "parser diagnostics")}: {snapshot.diagnostics.length}
        </div>
      )}
    </footer>
  );
}

export function BrainStatusSummary(props: BrainStatusSummaryProps) {
  const { t } = useI18n();
  const presentation = getBrainStatusPresentation(props);
  const { snapshot, displayRuntimeState, streaming, stale, sessionIsCurrent } = presentation;
  const age = snapshot ? getLocalizedAgeLabel(snapshot.sourceMessageTimestamp, props.now, t) : null;
  const activeHands = snapshot?.activeHands;
  const description = snapshot
    ? localized(t, STATUS_DESCRIPTION_KEYS[snapshot.status], STATUS_DESCRIPTIONS[snapshot.status])
    : null;
  const handLabel = activeHands === null ? "" : localized(
    t,
    activeHands === 1 ? "brainStatus.hand" : "brainStatus.hands",
    activeHands === 1 ? "hand" : "hands",
  );
  const runtimeStateLabel = localized(t, RUNTIME_STATE_KEYS[presentation.runtimeState], presentation.runtimeState);
  const runtimeText = streaming
    ? localized(t, "brainStatus.runtimeRunning", "runtime running")
    : `${localized(t, "brainStatus.runtime", "runtime")}: ${runtimeStateLabel}`;
  const statusText = snapshot
    ? `${localized(t, "brainStatus.status", "Brain status")} ${snapshot.status}: ${description}${activeHands === null ? "" : `, ${activeHands} ${handLabel}`}${stale ? `, ${localized(t, "brainStatus.lastKnown", "last known and not current")}` : ""}${age ? `, ${age}` : ""}, ${runtimeText}`
    : getLocalizedRuntimeFallbackLabel(displayRuntimeState, t);
  // Top-anchored at the pane's top-right corner (owner requirement): the
  // closed pill clears the transcript and the disclosure grows downward, so
  // it can never cover the wall composer at the bottom. The overlay is in
  // flow (alignSelf + margins anchor it at top:8/right:8) inside the
  // click-through stack's first row; the notice shelf is the second row.
  // Width never exceeds 1/6 viewport (owner cap) and maxWidth keeps it
  // inside the pane horizontally. pointerEvents opts the pill back in
  // inside the click-through notice stack that hosts it. The details is a
  // shrinkable flex item of the brain row (flex: 0 1 auto, minHeight: 0)
  // and scrolls its own content (overflowY: auto) when the stack's
  // container-bound height binds; the sticky summary keeps the pill visible
  // while the body scrolls underneath.
  const overlayStyle: CSSProperties = { alignSelf: "flex-end", marginTop: 8, marginRight: 8, zIndex: 50, width: "min(calc(100vw / 6), 280px)", maxWidth: "50%", minWidth: 0, minHeight: 0, flex: "0 1 auto", overflowY: "auto", overscrollBehavior: "contain", color: "var(--text)", fontSize: 11, pointerEvents: "auto" };
  const pillStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 7, minWidth: 0, minHeight: 30, padding: "5px 9px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", cursor: "pointer", boxShadow: "0 1px 2px rgba(15,23,42,0.05), 0 8px 24px -12px rgba(15,23,42,0.24)", position: "sticky", top: 0, flexShrink: 0, zIndex: 1 };
  const pillContent = (
    <>
      <StatusIcon status={snapshot?.status ?? null} />
      <span role="status" aria-live="polite" aria-label={statusText} style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, flex: "1 1 auto", overflow: "hidden" }}>
        {snapshot ? (
          <>
            <strong title={description ?? undefined} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11 }}>{snapshot.status}</strong>
            {activeHands !== null && <span style={{ flexShrink: 0, color: "var(--text-muted)", whiteSpace: "nowrap" }}>- {activeHands} {handLabel}</span>}
          </>
        ) : (
          <span data-brain-runtime-fallback={displayRuntimeState} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)" }}>{getLocalizedRuntimeFallbackLabel(displayRuntimeState, t)}</span>
        )}
      </span>
      {snapshot && stale && <span data-brain-stale-label="true" style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 10 }}>{localized(t, "brainStatus.stale", "STALE / LAST KNOWN")}</span>}
      {snapshot && streaming && <span data-brain-streaming="true" data-brain-runtime-state="running" style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--accent)", fontSize: 10 }}>{localized(t, "brainStatus.running", "RUNNING")}</span>}
      {snapshot && !streaming && presentation.runtimeState !== "idle" && <span data-brain-runtime-state={presentation.runtimeState} style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>{localized(t, "brainStatus.runtime", "runtime")}: {runtimeStateLabel}</span>}
      {snapshot && age && <span data-brain-status-age="true" style={{ flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>{age}</span>}
    </>
  );

  // Without a trusted snapshot there are no details to disclose, so the
  // fallback renders a plain status pill instead of an empty disclosure.
  if (!snapshot) {
    return (
      <div
        data-brain-status-summary="true"
        data-brain-session-id={props.sessionId}
        data-brain-current={sessionIsCurrent ? "true" : "false"}
        data-brain-stale={stale ? "true" : "false"}
        style={overlayStyle}
      >
        <div style={pillStyle}>{pillContent}</div>
      </div>
    );
  }

  return (
    <details
      data-brain-status-summary="true"
      data-brain-session-id={props.sessionId}
      data-brain-current={sessionIsCurrent ? "true" : "false"}
      data-brain-stale={stale ? "true" : "false"}
      data-brain-status={snapshot.status}
      style={{ ...overlayStyle, display: "flex", flexDirection: "column" }}
    >
      <summary style={pillStyle}>
        {pillContent}
      </summary>
      <div style={{ border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 8px 8px", background: "var(--bg)" }}>
        <StatusFooter snapshot={snapshot} t={t} />
      </div>
    </details>
  );
}
