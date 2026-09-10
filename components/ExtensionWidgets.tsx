"use client";

import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AnsiText } from "@/components/AnsiText";
import type { ExtensionWidgetItem } from "@/lib/types";

export const DEFAULT_EXPANDED_WIDGET_LINES = 3;
export const WIDGET_UPDATE_IDLE_MS = 1100;

export function formatExtensionWidgetContent(lines: string[]): string {
  return lines.join("\n");
}

export function snapshotExtensionWidgetContents(
  widgets: ExtensionWidgetItem[],
): Map<string, string[]> {
  return new Map(widgets.map((widget) => [widget.key, [...widget.lines]]));
}

export function getUpdatedExtensionWidgetKeys(
  previous: ReadonlyMap<string, readonly string[]> | null,
  next: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!previous) return [];
  return Array.from(next, ([key, lines]) => {
    const previousLines = previous.get(key);
    if (!previousLines || previousLines.length !== lines.length) {
      return previousLines ? key : null;
    }
    return lines.some((line, index) => line !== previousLines[index]) ? key : null;
  }).filter((key): key is string => key !== null);
}

function getDefaultExpandedWidgetKey(widgets: ExtensionWidgetItem[]): string | null {
  return widgets.find((widget) => {
    const lineCount = widget.lines.length;
    return lineCount > 1 && lineCount <= DEFAULT_EXPANDED_WIDGET_LINES;
  })?.key ?? null;
}

export function getNextExpandedWidgetKey(
  currentKey: string | null,
  requestedKey: string,
): string | null {
  return currentKey === requestedKey ? null : requestedKey;
}

export function getWidgetPanelPosition(
  triggerRect: Pick<DOMRect, "top" | "right" | "bottom">,
  viewport: { width: number; height: number; offsetLeft?: number; offsetTop?: number },
): { top: number; left: number; width: number; maxHeight: number } | null {
  const padding = 8;
  const gap = 6;
  const minimumHeight = 72;
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null;

  const viewportLeft = viewport.offsetLeft ?? 0;
  const viewportTop = viewport.offsetTop ?? 0;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const width = Math.min(420, viewport.width - padding * 2);
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

  const candidateMaxHeight = Math.min(
    280,
    availableHeight >= minimumHeight ? availableHeight : fallbackHeight,
  );
  const viewportMinTop = viewportTop + padding;
  const viewportMaxTop = viewportBottom - padding - minimumHeight;
  if (viewportMaxTop < viewportMinTop) return null;
  const candidateTop = availableHeight >= minimumHeight
    ? placeAbove
      ? triggerTop - gap - candidateMaxHeight
      : triggerBottom + gap
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

export function ExtensionWidgets({
  widgets,
  wallPane = false,
}: {
  widgets: ExtensionWidgetItem[];
  wallPane?: boolean;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const previousContentsRef = useRef<Map<string, string[]> | null>(null);
  const updateClearTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const expandedPanelRef = useRef<HTMLDivElement>(null);
  const expandedFocusKeyRef = useRef<string | null>(null);
  const [expandedWidgetKey, setExpandedWidgetKey] = useState<string | null>(
    () => getDefaultExpandedWidgetKey(widgets),
  );
  const [expandedWidgetPosition, setExpandedWidgetPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [updatingWidgetKeys, setUpdatingWidgetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const nextContents = snapshotExtensionWidgetContents(widgets);
    const updatedKeys = getUpdatedExtensionWidgetKeys(
      previousContentsRef.current,
      nextContents,
    );
    previousContentsRef.current = nextContents;

    for (const [key, timer] of updateClearTimersRef.current) {
      if (nextContents.has(key)) continue;
      clearTimeout(timer);
      updateClearTimersRef.current.delete(key);
    }

    setUpdatingWidgetKeys((current) => {
      const next = new Set(Array.from(current).filter((key) => nextContents.has(key)));
      for (const key of updatedKeys) next.add(key);
      if (
        next.size === current.size
        && Array.from(next).every((key) => current.has(key))
      ) return current;
      return next;
    });

    for (const key of updatedKeys) {
      const currentTimer = updateClearTimersRef.current.get(key);
      if (currentTimer) clearTimeout(currentTimer);
      updateClearTimersRef.current.set(key, setTimeout(() => {
        updateClearTimersRef.current.delete(key);
        setUpdatingWidgetKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }, WIDGET_UPDATE_IDLE_MS));
    }
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of updateClearTimersRef.current.values()) clearTimeout(timer);
    updateClearTimersRef.current.clear();
  }, []);

  const expandedWidget = widgets.find((widget) => (
    widget.key === expandedWidgetKey
    && widget.lines.length > 0
  ));

  useEffect(() => {
    if (expandedWidgetKey && !expandedWidget) setExpandedWidgetKey(null);
  }, [expandedWidgetKey, expandedWidget]);

  useLayoutEffect(() => {
    if (!wallPane || !expandedWidget) {
      setExpandedWidgetPosition(null);
      return;
    }

    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const trigger = triggerRefs.current.get(expandedWidget.key);
      if (!trigger) return;
      const viewport = window.visualViewport;
      const position = getWidgetPanelPosition(trigger.getBoundingClientRect(), {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        offsetLeft: viewport?.offsetLeft ?? 0,
        offsetTop: viewport?.offsetTop ?? 0,
      });
      if (!position) {
        setExpandedWidgetKey(null);
        setExpandedWidgetPosition(null);
        return;
      }
      setExpandedWidgetPosition(position);
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
  }, [expandedWidget, wallPane]);

  useLayoutEffect(() => {
    if (!wallPane || !expandedWidget || !expandedWidgetPosition) {
      if (!expandedWidget) expandedFocusKeyRef.current = null;
      return;
    }
    if (expandedFocusKeyRef.current === expandedWidget.key) return;
    const panel = expandedPanelRef.current;
    if (!panel) return;
    expandedFocusKeyRef.current = expandedWidget.key;
    const firstControl = panel.querySelector<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (firstControl ?? panel).focus();
  }, [expandedWidget, expandedWidgetPosition, wallPane]);

  useEffect(() => {
    if (!wallPane || !expandedWidget) return;
    const expandedKey = expandedWidget.key;
    const focusTrigger = () => {
      const trigger = triggerRefs.current.get(expandedKey);
      if (trigger?.isConnected) trigger.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const trigger = triggerRefs.current.get(expandedKey);
      if (expandedPanelRef.current?.contains(target) || trigger?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      const intentionalTarget = Boolean(
        element
        && element.isConnected
        && element.closest(
          'button, a, input, select, textarea, label, summary, [contenteditable="true"], [draggable="true"], [role], [tabindex]:not([tabindex="-1"])',
        ),
      );
      setExpandedWidgetKey(null);
      setExpandedWidgetPosition(null);
      if (!intentionalTarget) focusTrigger();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as Node | null;
      const trigger = triggerRefs.current.get(expandedKey);
      const ownedByWidget = expandedPanelRef.current?.contains(target) || trigger?.contains(target);
      if (!ownedByWidget) return;
      event.preventDefault();
      event.stopPropagation();
      setExpandedWidgetKey(null);
      setExpandedWidgetPosition(null);
      focusTrigger();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [expandedWidget, wallPane]);

  if (widgets.length === 0) return null;

  const toggleWidget = (widget: ExtensionWidgetItem) => {
    const closing = expandedWidgetKey === widget.key;
    setExpandedWidgetKey(closing ? null : widget.key);
    setExpandedWidgetPosition(null);
    if (closing) {
      const trigger = triggerRefs.current.get(widget.key);
      if (trigger?.isConnected) trigger.focus();
    }
  };

  const expandedIndex = expandedWidget ? widgets.indexOf(expandedWidget) : -1;
  const expandedTriggerId = expandedIndex >= 0 ? `${idPrefix}-trigger-${expandedIndex}` : undefined;
  const expandedPanelId = expandedIndex >= 0 ? `${idPrefix}-panel-${expandedIndex}` : undefined;
  const expandedPanel = expandedWidget && expandedPanelId && expandedTriggerId ? (
    <div
      ref={wallPane ? expandedPanelRef : undefined}
      id={expandedPanelId}
      className="extension-widget-panels"
      role={wallPane ? "dialog" : undefined}
      aria-modal={wallPane ? false : undefined}
      tabIndex={wallPane ? -1 : undefined}
      aria-labelledby={expandedTriggerId}
      style={wallPane && expandedWidgetPosition ? {
        position: "fixed",
        top: expandedWidgetPosition.top,
        left: expandedWidgetPosition.left,
        zIndex: 130,
        width: expandedWidgetPosition.width,
        maxHeight: expandedWidgetPosition.maxHeight,
        minHeight: 72,
        boxSizing: "border-box",
        border: "1px solid var(--border)",
        borderRadius: 5,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      } : undefined}
    >
      <section
        className="extension-widget-panel"
        aria-labelledby={expandedTriggerId}
      >
        <div className="extension-widget-panel-heading">{expandedWidget.key}</div>
        <pre className="extension-widget-content">
          <AnsiText text={formatExtensionWidgetContent(expandedWidget.lines)} />
        </pre>
      </section>
    </div>
  ) : null;

  return (
    <>
      {!wallPane && expandedPanel}
      {wallPane && expandedPanel && expandedWidgetPosition && typeof document !== "undefined"
        ? createPortal(expandedPanel, document.body)
        : null}
      <div className="extension-widget-triggers" aria-label={t("chat.extensionWidgets")}>
        {widgets.map((widget, index) => {
          const expandable = widget.lines.length > 0;
          const expanded = expandable && widget.key === expandedWidget?.key;
          const updating = updatingWidgetKeys.has(widget.key);
          const lineCountLabel = t(
            widget.lines.length === 1 ? "chat.extensionWidgetLine" : "chat.extensionWidgetLines",
            { count: widget.lines.length },
          );
          const placementLabel = t(
            widget.placement === "belowEditor"
              ? "chat.extensionWidgetBelow"
              : "chat.extensionWidgetAbove",
          );
          const triggerId = `${idPrefix}-trigger-${index}`;
          const panelId = `${idPrefix}-panel-${index}`;
          const content = (
            <>
              <span className="extension-widget-update-pulse" aria-hidden="true" />
              <span className="extension-widget-placement" aria-hidden="true">
                <svg
                  className="extension-widget-placement-icon"
                  viewBox="0 0 8 6"
                  width="8"
                  height="6"
                  data-direction={widget.placement === "belowEditor" ? "down" : "up"}
                  focusable="false"
                >
                  <path
                    d={widget.placement === "belowEditor"
                      ? "M0 0h8L4 6z"
                      : "M4 0l4 6H0z"}
                  />
                </svg>
              </span>
              <span className="extension-widget-key">{widget.key}</span>
            </>
          );

          return expandable ? (
            <button
              key={widget.key}
              ref={(element) => {
                if (element) triggerRefs.current.set(widget.key, element);
                else triggerRefs.current.delete(widget.key);
              }}
              id={triggerId}
              type="button"
              className={`extension-widget-trigger${expanded ? " is-expanded" : ""}${updating ? " is-updating" : ""}`}
              aria-controls={panelId}
              aria-expanded={expanded}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel} - ${expanded ? t("i18n.collapse") : t("i18n.expand")}`}
              onClick={() => toggleWidget(widget)}
            >
              {content}
            </button>
          ) : (
            <div
              key={widget.key}
              className={`extension-widget-trigger${updating ? " is-updating" : ""}`}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel}`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </>
  );
}
