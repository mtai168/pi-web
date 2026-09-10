"use client";

import type { CSSProperties } from "react";
import { SESSION_WALL_LAYOUTS, type SessionWallLayout } from "@/lib/session-wall/types";

export interface SessionWallToolbarLabels {
  layout: string;
  manage: string;
  running: string;
  attention: string;
  "2x2": string;
  "2x4": string;
  "2x6": string;
}

export const DEFAULT_SESSION_WALL_TOOLBAR_LABELS: SessionWallToolbarLabels = Object.freeze({
  layout: "Layout", manage: "Manage sessions", running: "Running", attention: "Needs attention",
  "2x2": "2x2", "2x4": "2x4", "2x6": "2x6",
});

export interface SessionWallToolbarProps {
  layout: SessionWallLayout;
  runningCount: number;
  attentionCount: number;
  productIdentity?: string;
  productShortIdentity?: string;
  labels?: Partial<SessionWallToolbarLabels>;
  onLayoutChange: (layout: SessionWallLayout) => void;
  onOpenManagement: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

function Icon({ kind }: { kind: "layout" | "manage" }) {
  return kind === "layout"
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--bg-panel)" /><circle cx="15" cy="12" r="2" fill="var(--bg-panel)" /><circle cx="11" cy="18" r="2" fill="var(--bg-panel)" /></svg>;
}

export function SessionWallToolbar({
  layout, runningCount, attentionCount, productIdentity, productShortIdentity, labels: overrides, onLayoutChange, onOpenManagement,
  disabled = false, ariaLabel, className, style,
}: SessionWallToolbarProps) {
  const labels = { ...DEFAULT_SESSION_WALL_TOOLBAR_LABELS, ...overrides };
  const choices = SESSION_WALL_LAYOUTS;
  const productShort = productShortIdentity?.trim() || null;
  const buttonStyle: CSSProperties = { minHeight: 28, padding: "4px 8px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: disabled ? "default" : "pointer", font: "inherit", fontSize: 11 };
  return <div role="toolbar" aria-label={ariaLabel ?? labels.layout} className={`${className ?? ""} session-wall-toolbar`.trim()} style={{ display: "flex", alignItems: "center", gap: 6, flex: "1 1 auto", minWidth: 0, minHeight: 36, boxSizing: "border-box", overflow: "hidden", padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "color-mix(in srgb, var(--bg-panel) 94%, var(--text))", color: "var(--text-muted)", ...style }} data-session-wall-toolbar="true" data-session-wall-layout={layout}>
    <style>{`[data-session-wall-toolbar] button:focus-visible,[data-session-wall-toolbar] select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}[data-session-wall-toolbar] .wall-toolbar-layout-buttons{display:inline-flex}[data-session-wall-toolbar] .wall-toolbar-layout-caption{display:inline-flex}[data-session-wall-toolbar] .wall-toolbar-product-short,[data-session-wall-toolbar] .wall-toolbar-layout-select{display:none}@media (max-width:980px){[data-session-wall-toolbar] .wall-toolbar-product-full{display:none}[data-session-wall-toolbar] .wall-toolbar-product-short{display:inline}[data-session-wall-toolbar] .wall-toolbar-attention-label{display:none}}@media (max-width:760px){[data-session-wall-toolbar]{gap:4px;padding-inline:4px}[data-session-wall-toolbar] .wall-toolbar-layout-buttons{display:none}[data-session-wall-toolbar] .wall-toolbar-layout-select{display:block;min-width:42px;max-width:58px}[data-session-wall-toolbar] .wall-toolbar-running-label{display:none}[data-session-wall-toolbar] .wall-toolbar-manage-label{display:none}}@media (max-width:680px){[data-session-wall-toolbar] .wall-toolbar-layout-caption{display:none}[data-session-wall-toolbar] .wall-toolbar-metric{gap:3px}}`}</style>
    {productIdentity && <span style={{ display: "inline-flex", alignItems: "center", minWidth: 0, flex: "0 1 auto", color: "var(--text)", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}><span className={productShort ? "wall-toolbar-product-full" : "wall-toolbar-product-fallback"} data-session-wall-product-identity="true" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{productIdentity}</span>{productShort && <span className="wall-toolbar-product-short">{productShort}</span>}</span>}
    <span className="wall-toolbar-layout-caption" style={{ alignItems: "center", gap: 5, flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}><Icon kind="layout" /><span>{labels.layout}</span></span>
    <div className="wall-toolbar-layout-buttons" role="group" aria-label={labels.layout} style={{ alignItems: "center", gap: 2, flexShrink: 0, padding: 2, border: "1px solid var(--border)", borderRadius: 5 }}>
      {choices.map((choice) => <button key={choice} type="button" onClick={() => onLayoutChange(choice)} disabled={disabled} aria-pressed={layout === choice} aria-label={`${labels.layout}: ${labels[choice]}`} title={labels[choice]} style={{ ...buttonStyle, background: layout === choice ? "var(--bg-selected)" : "transparent", color: layout === choice ? "var(--text)" : "var(--text-muted)", fontWeight: layout === choice ? 600 : 400 }}>{labels[choice]}</button>)}
    </div>
    <select className="wall-toolbar-layout-select" value={layout} onChange={(event) => onLayoutChange(event.target.value as SessionWallLayout)} disabled={disabled} aria-label={labels.layout} title={labels.layout} style={{ height: 28, padding: "0 3px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 11 }}>
      {choices.map((choice) => <option key={choice} value={choice}>{labels[choice]}</option>)}
    </select>
    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: "1 1 auto", overflow: "hidden", fontSize: 11, whiteSpace: "nowrap" }}>
      <div className="wall-toolbar-metric" role="status" aria-label={`${labels.running}: ${runningCount}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}><span aria-hidden="true" style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} /><span className="wall-toolbar-running-label">{labels.running}: </span><span style={{ fontVariantNumeric: "tabular-nums" }}>{runningCount}</span></div>
      {attentionCount > 0 && <span className="wall-toolbar-metric" role="status" aria-label={`${labels.attention}: ${attentionCount}`} style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, color: "var(--accent)" }}><span aria-hidden="true">!</span><span className="wall-toolbar-attention-label">{labels.attention}: </span><span style={{ fontVariantNumeric: "tabular-nums" }}>{attentionCount}</span></span>}
    </div>
    <button type="button" onClick={onOpenManagement} disabled={disabled} aria-label={labels.manage} title={labels.manage} style={{ ...buttonStyle, display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, border: "1px solid var(--border)", background: "var(--bg)", color: disabled ? "var(--text-dim)" : "var(--text-muted)" }}><Icon kind="manage" /><span className="wall-toolbar-manage-label">{labels.manage}</span></button>
  </div>;
}
