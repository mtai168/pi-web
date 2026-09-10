"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";
import { getSessionWallLayoutPolicy, type SessionWallLayoutPolicy } from "@/lib/session-wall/layout";
import type { SessionWallConfigV1, SessionWallPaneConfig } from "@/lib/session-wall/types";
import { SessionWallGrid } from "./SessionWallGrid";
import {
  DEFAULT_SESSION_WALL_PANE_LABELS,
  getSessionWallPaneRuntimeKey,
  SessionWallPane,
  type SessionWallPaneLabels,
  type SessionWallPaneMetadata,
  type SessionWallPaneRenderContext,
  type SessionWallPaneState,
} from "./SessionWallPane";

const OUTER_SCROLL_SAVE_DEBOUNCE_MS = 200;

function normalizeOuterScrollTop(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function clampOuterScrollTop(value: number, maxScrollTop: number): number {
  return Math.min(normalizeOuterScrollTop(value), Math.max(0, Number.isFinite(maxScrollTop) ? maxScrollTop : 0));
}

export interface OuterScrollSourceRegistry {
  register(wallId: string, sourceId: object): void;
  unregister(wallId: string, sourceId: object): boolean;
  isCurrent(wallId: string, sourceId: object): boolean;
  acceptClaim(wallId: string, sourceId: object, transitionFlush?: boolean): object | null;
  isValidClaim(wallId: string, sourceId: object, claim: object): boolean;
}

export function createOuterScrollSourceRegistry(): OuterScrollSourceRegistry {
  const sources = new Map<string, object>();
  const claims = new WeakMap<object, { wallId: string; sourceId: object; transitionFlush: boolean }>();
  return {
    register(wallId, sourceId) {
      sources.set(wallId, sourceId);
    },
    unregister(wallId, sourceId) {
      if (sources.get(wallId) !== sourceId) return false;
      sources.delete(wallId);
      return true;
    },
    isCurrent(wallId, sourceId) {
      return sources.get(wallId) === sourceId;
    },
    acceptClaim(wallId, sourceId, transitionFlush = false) {
      if (sources.get(wallId) !== sourceId) return null;
      const claim = {};
      claims.set(claim, { wallId, sourceId, transitionFlush });
      return claim;
    },
    isValidClaim(wallId, sourceId, claim) {
      const bound = claims.get(claim);
      if (bound === undefined || bound.wallId !== wallId || bound.sourceId !== sourceId) return false;
      return bound.transitionFlush || sources.get(wallId) === sourceId;
    },
  };
}

export interface SessionWallProps {
  config: SessionWallConfigV1;
  viewportWidth: number;
  availableHeight: number;
  paneMetadata?: Readonly<Record<string, SessionWallPaneMetadata>>;
  getPaneMetadata?: (pane: SessionWallPaneConfig, index: number) => SessionWallPaneMetadata | undefined;
  paneStates?: Readonly<Record<string, SessionWallPaneState>>;
  getPaneState?: (pane: SessionWallPaneConfig, index: number) => SessionWallPaneState | undefined;
  getPaneBlockingAttention?: (pane: SessionWallPaneConfig, index: number) => boolean;
  onOuterScrollTopChange?: (wallId: string, outerScrollTop: number, sourceId: object, transitionFlush?: boolean) => void;
  onOuterScrollSourceChange?: (wallId: string, sourceId: object, active: boolean) => void;
  renderPane?: (context: SessionWallPaneRenderContext) => ReactNode;
  renderPaneFooter?: (context: SessionWallPaneRenderContext) => ReactNode;
  onFocusPane?: (pane: SessionWallPaneConfig) => void;
  onSelectEmptyPane?: (paneId: string) => void;
  onRetryPane?: (pane: SessionWallPaneConfig) => void;
  onReplacePane?: (pane: SessionWallPaneConfig) => void;
  onRemovePane?: (pane: SessionWallPaneConfig) => void;
  onExpandPane?: (pane: SessionWallPaneConfig) => void;
  onJumpToLatestPane?: (pane: SessionWallPaneConfig) => void;
  getPaneResetKey?: (pane: SessionWallPaneConfig, index: number) => string | number | null;
  labels?: Partial<SessionWallPaneLabels>;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

export function getSessionWallPolicy(
  config: Pick<SessionWallConfigV1, "layout">,
  viewportWidth: number,
  availableHeight: number,
): SessionWallLayoutPolicy {
  return getSessionWallLayoutPolicy({ layout: config.layout, viewportWidth, availableHeight });
}

export function SessionWall({
  config,
  viewportWidth,
  availableHeight,
  paneMetadata,
  getPaneMetadata,
  paneStates,
  getPaneState,
  getPaneBlockingAttention,
  onOuterScrollTopChange,
  onOuterScrollSourceChange,
  renderPane,
  renderPaneFooter,
  onFocusPane,
  onSelectEmptyPane,
  onRetryPane,
  onReplacePane,
  onRemovePane,
  onExpandPane,
  onJumpToLatestPane,
  getPaneResetKey,
  labels: labelOverrides,
  ariaLabel = "Session Wall",
  className,
  style,
}: SessionWallProps) {
  const labels = { ...DEFAULT_SESSION_WALL_PANE_LABELS, ...labelOverrides };
  const policy = getSessionWallPolicy(config, viewportWidth, availableHeight);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const [outerScrollTop, setOuterScrollTop] = useState(() => normalizeOuterScrollTop(config.outerScrollTop));
  const [outerViewportHeight, setOuterViewportHeight] = useState(0);
  const restoredOuterScrollKeyRef = useRef<string | null>(null);
  const pendingOuterScrollRef = useRef<{ wallId: string; scrollTop: number } | null>(null);
  const outerScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outerScrollSourceRef = useRef<object>({});
  const outerScrollDisabledRef = useRef(false);
  outerScrollDisabledRef.current = policy.viewport.mobileDisabled;
  const onOuterScrollTopChangeRef = useRef(onOuterScrollTopChange);
  onOuterScrollTopChangeRef.current = onOuterScrollTopChange;
  const onOuterScrollSourceChangeRef = useRef(onOuterScrollSourceChange);
  onOuterScrollSourceChangeRef.current = onOuterScrollSourceChange;

  const flushOuterScrollPersistence = useCallback((transitionFlush = false) => {
    if (outerScrollDisabledRef.current) {
      pendingOuterScrollRef.current = null;
      return;
    }
    const pending = pendingOuterScrollRef.current;
    pendingOuterScrollRef.current = null;
    if (pending) onOuterScrollTopChangeRef.current?.(pending.wallId, pending.scrollTop, outerScrollSourceRef.current, transitionFlush);
  }, []);

  const queueOuterScrollPersistence = useCallback((value: number) => {
    if (pendingOuterScrollRef.current && pendingOuterScrollRef.current.wallId !== config.wallId) {
      flushOuterScrollPersistence(true);
    }
    pendingOuterScrollRef.current = {
      wallId: config.wallId,
      scrollTop: normalizeOuterScrollTop(value),
    };
    if (outerScrollTimerRef.current) clearTimeout(outerScrollTimerRef.current);
    outerScrollTimerRef.current = setTimeout(() => {
      outerScrollTimerRef.current = null;
      flushOuterScrollPersistence();
    }, OUTER_SCROLL_SAVE_DEBOUNCE_MS);
  }, [config.wallId, flushOuterScrollPersistence]);

  useEffect(() => () => {
    if (outerScrollTimerRef.current) clearTimeout(outerScrollTimerRef.current);
    outerScrollTimerRef.current = null;
    flushOuterScrollPersistence(true);
  }, [flushOuterScrollPersistence]);

  useEffect(() => {
    if (policy.viewport.mobileDisabled) {
      if (outerScrollTimerRef.current) {
        clearTimeout(outerScrollTimerRef.current);
        outerScrollTimerRef.current = null;
      }
      pendingOuterScrollRef.current = null;
      restoredOuterScrollKeyRef.current = null;
      return;
    }
    const sourceId = outerScrollSourceRef.current;
    onOuterScrollSourceChangeRef.current?.(config.wallId, sourceId, true);
    return () => {
      if (pendingOuterScrollRef.current?.wallId === config.wallId) flushOuterScrollPersistence(true);
      onOuterScrollSourceChangeRef.current?.(config.wallId, sourceId, false);
    };
  }, [config.wallId, flushOuterScrollPersistence, policy.viewport.mobileDisabled]);

  useLayoutEffect(() => {
    const element = outerRef.current;
    if (!element) return;
    const updateViewportHeight = () => setOuterViewportHeight(element.clientHeight);
    updateViewportHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [availableHeight, config.wallId, policy.contentHeight, policy.viewport.mobileDisabled]);

  useLayoutEffect(() => {
    const element = outerRef.current;
    if (!element) return;
    const viewportHeight = element.clientHeight;
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;

    const restoreKey = `${config.wallId}:${config.layout}`;
    const needsRestore = restoredOuterScrollKeyRef.current !== restoreKey;
    const requestedScrollTop = needsRestore ? config.outerScrollTop : element.scrollTop;
    const clampedScrollTop = clampOuterScrollTop(
      requestedScrollTop,
      element.scrollHeight - viewportHeight,
    );
    if (needsRestore || clampedScrollTop !== element.scrollTop) {
      element.scrollTop = clampedScrollTop;
      setOuterScrollTop(clampedScrollTop);
    } else {
      setOuterScrollTop((current) => current === element.scrollTop ? current : element.scrollTop);
    }
    restoredOuterScrollKeyRef.current = restoreKey;
    if (clampedScrollTop !== normalizeOuterScrollTop(config.outerScrollTop)) {
      queueOuterScrollPersistence(clampedScrollTop);
    }
  }, [config.layout, config.outerScrollTop, config.wallId, outerViewportHeight, policy.contentHeight, policy.viewport.mobileDisabled, queueOuterScrollPersistence]);

  const handleOuterScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextScrollTop = normalizeOuterScrollTop(event.currentTarget.scrollTop);
    setOuterScrollTop(nextScrollTop);
    queueOuterScrollPersistence(nextScrollTop);
  }, [queueOuterScrollPersistence]);

  const outerStyle: CSSProperties = {
    ...style,
    display: "block",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    overflowX: "hidden",
    overflowY: policy.requiresOuterScroll ? "auto" : "hidden",
    scrollbarGutter: "stable",
    background: "var(--bg)",
    color: "var(--text)",
  };

  // The mobile-disabled policy never mounts the grid or pane runtimes; the
  // shell below keeps the wall region contract without scroll or pane state.
  if (policy.viewport.mobileDisabled) {
    return (
      <div
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
        className={className}
        style={outerStyle}
        data-session-wall="true"
        data-session-wall-mobile-disabled="true"
        data-session-wall-viewport-supported="false"
      />
    );
  }

  return (
    <div
      ref={outerRef}
      onScroll={handleOuterScroll}
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      className={className}
      style={outerStyle}
      data-session-wall="true"
      data-session-wall-layout={config.layout}
      data-session-wall-outer-scroll={policy.requiresOuterScroll ? "true" : "false"}
      data-session-wall-pane-height={policy.paneHeight}
      data-session-wall-viewport-supported={policy.viewport.supported ? "true" : "false"}
    >
      <SessionWallGrid
        panes={config.panes}
        policy={policy}
        outerScrollTop={outerScrollTop}
        outerViewportHeight={outerViewportHeight}
        ariaLabel={`${ariaLabel} panes`}
        renderPane={(pane, index, inOverscan) => {
          const metadata = getPaneMetadata?.(pane, index) ?? paneMetadata?.[pane.paneId];
          const state = getPaneState?.(pane, index) ?? paneStates?.[pane.paneId];
          const blockingAttention = getPaneBlockingAttention?.(pane, index) === true;
          const action = (callback: ((target: SessionWallPaneConfig) => void) | undefined) => (
            callback ? () => callback(pane) : undefined
          );
          return (
            <SessionWallPane
              key={getSessionWallPaneRuntimeKey(pane)}
              pane={pane}
              metadata={metadata}
              state={state}
              layout={config.layout}
              inOverscan={inOverscan}
              blockingAttention={blockingAttention}
              focused={config.focusedPaneId === pane.paneId}
              renderContent={renderPane}
              renderFooter={renderPaneFooter}
              onFocus={action(onFocusPane)}
              onSelectSession={pane.sessionId === null && onSelectEmptyPane ? () => onSelectEmptyPane(pane.paneId) : undefined}
              onRetry={action(onRetryPane)}
              onReplace={action(onReplacePane)}
              onRemove={action(onRemovePane)}
              onExpand={action(onExpandPane)}
              onJumpToLatest={action(onJumpToLatestPane)}
              resetKey={getPaneResetKey?.(pane, index)}
              labels={labels}
            />
          );
        }}
      />
    </div>
  );
}
