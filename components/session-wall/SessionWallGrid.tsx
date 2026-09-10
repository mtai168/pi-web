"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  SESSION_WALL_GRID_GAP,
  type SessionWallLayoutPolicy,
} from "@/lib/session-wall/layout";
import type { SessionWallPaneConfig } from "@/lib/session-wall/types";

export interface SessionWallGridProps {
  panes: readonly SessionWallPaneConfig[];
  policy: SessionWallLayoutPolicy;
  renderPane: (pane: SessionWallPaneConfig, index: number, inOverscan: boolean) => ReactNode;
  outerScrollTop?: number;
  outerViewportHeight?: number;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

function createFallbackPane(index: number, usedPaneIds: Set<string>, reservedPaneIds: Set<string>): SessionWallPaneConfig {
  let paneId = `pane-${index + 1}`;
  let suffix = index + 1;
  while (usedPaneIds.has(paneId) || reservedPaneIds.has(paneId)) {
    suffix += 1;
    paneId = `pane-${suffix}`;
  }
  usedPaneIds.add(paneId);
  return { paneId, sessionId: null };
}

export function getSessionWallPaneSlots(
  panes: readonly SessionWallPaneConfig[],
  slotCount: 4 | 8 | 12,
): SessionWallPaneConfig[] {
  const paneIds = new Set<string>();
  for (const pane of panes) {
    if (paneIds.has(pane.paneId)) throw new RangeError(`Duplicate Session Wall pane id: ${pane.paneId}`);
    paneIds.add(pane.paneId);
  }
  const reservedPaneIds = new Set(paneIds);
  return Array.from({ length: slotCount }, (_, index) => (
    panes[index] ?? createFallbackPane(index, paneIds, reservedPaneIds)
  ));
}

export function getSessionWallGridTemplate(policy: SessionWallLayoutPolicy): string {
  return `repeat(${policy.rows}, ${policy.paneHeight}px)`;
}

type SessionWallOverscanPolicy = Pick<SessionWallLayoutPolicy, "columns" | "rows" | "paneHeight" | "contentHeight">;

function getVisibleRowRange(
  policy: SessionWallOverscanPolicy,
  outerScrollTop?: number,
  outerViewportHeight?: number,
): { firstRow: number; lastRow: number } | null {
  if (
    !Number.isSafeInteger(policy.columns)
    || policy.columns < 1
    || !Number.isSafeInteger(policy.rows)
    || policy.rows < 1
    || !Number.isFinite(policy.paneHeight)
    || policy.paneHeight <= 0
    || !Number.isFinite(policy.contentHeight)
    || policy.contentHeight < 0
    || typeof outerScrollTop !== "number"
    || !Number.isFinite(outerScrollTop)
    || outerScrollTop < 0
    || typeof outerViewportHeight !== "number"
    || !Number.isFinite(outerViewportHeight)
    || outerViewportHeight <= 0
  ) return null;

  const maxScrollTop = Math.max(0, policy.contentHeight - outerViewportHeight);
  const scrollTop = Math.min(outerScrollTop, maxScrollTop);
  const viewportBottom = scrollTop + outerViewportHeight;
  const rowStep = policy.paneHeight + SESSION_WALL_GRID_GAP;
  let firstRow = -1;
  let lastRow = -1;

  for (let row = 0; row < policy.rows; row += 1) {
    const rowTop = row * rowStep;
    const rowBottom = rowTop + policy.paneHeight;
    if (rowTop < viewportBottom && rowBottom > scrollTop) {
      if (firstRow < 0) firstRow = row;
      lastRow = row;
    }
  }

  return firstRow < 0 ? null : { firstRow, lastRow };
}

export function isSessionWallPaneInOverscan(
  index: number,
  policy: SessionWallOverscanPolicy,
  outerScrollTop?: number,
  outerViewportHeight?: number,
): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index >= policy.rows * policy.columns) return false;
  const visibleRows = getVisibleRowRange(policy, outerScrollTop, outerViewportHeight);
  if (!visibleRows) return true;
  const firstRow = Math.max(0, visibleRows.firstRow - 1);
  const lastRow = Math.min(policy.rows - 1, visibleRows.lastRow + 1);
  const row = Math.floor(index / policy.columns);
  return row >= firstRow && row <= lastRow;
}

export function SessionWallGrid({
  panes,
  policy,
  renderPane,
  outerScrollTop,
  outerViewportHeight,
  ariaLabel = "Session Wall panes",
  className,
  style,
}: SessionWallGridProps) {
  const slots = getSessionWallPaneSlots(panes, policy.slotCount);
  const gridStyle: CSSProperties = {
    ...style,
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gridTemplateRows: getSessionWallGridTemplate(policy),
    gridAutoRows: `${policy.paneHeight}px`,
    gap: `${SESSION_WALL_GRID_GAP}px`,
    width: "100%",
    minWidth: 0,
    minHeight: policy.contentHeight,
    alignContent: "start",
  };

  return (
    <div
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={policy.rows}
      aria-colcount={policy.columns}
      className={className}
      style={gridStyle}
      data-session-wall-grid="true"
      data-session-wall-slot-count={policy.slotCount}
      data-session-wall-columns={policy.columns}
    >
      {slots.map((pane, index) => {
        const inOverscan = isSessionWallPaneInOverscan(index, policy, outerScrollTop, outerViewportHeight);
        return (
          <div
            key={pane.paneId}
            role="gridcell"
            aria-rowindex={Math.floor(index / policy.columns) + 1}
            aria-colindex={(index % policy.columns) + 1}
            data-session-wall-slot-index={index}
            data-session-wall-pane-id={pane.paneId}
            data-session-wall-in-overscan={inOverscan ? "true" : "false"}
            style={{
              display: "flex",
              minWidth: 0,
              minHeight: policy.paneHeight,
              height: policy.paneHeight,
            }}
          >
            {renderPane(pane, index, inOverscan)}
          </div>
        );
      })}
    </div>
  );
}
