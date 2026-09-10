"use client";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  wallPane = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  wallPane?: boolean;
}) {
  if (statuses.length === 0 && widgets.length === 0) return null;

  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  if (wallPane) {
    return (
      <div className={`extension-status-shelf wall-extension-status-inline${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`} data-extension-status-wall="true">
        {widgets.length > 0 && <ExtensionWidgets widgets={widgets} wallPane />}
        {statuses.length > 0 && (
          <details className="wall-extension-status-details" data-extension-status-details="true">
            <summary className="wall-extension-status-summary" aria-label={plainStatusLine} aria-live="polite" title={plainStatusLine}>{plainStatusLine}</summary>
            <div aria-hidden="true" className="extension-status-line wall-extension-status-line" title={plainStatusLine}><AnsiText text={statusLine} /></div>
          </details>
        )}
      </div>
    );
  }

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {widgets.length > 0 && <ExtensionWidgets widgets={widgets} wallPane={wallPane} />}
      {statuses.length > 0 && (
        <div
          role="status"
          className="extension-status-line"
          aria-label={plainStatusLine}
          title={plainStatusLine}
        >
          <span className="extension-status-text">
            <AnsiText text={statusLine} />
          </span>
        </div>
      )}
    </div>
  );
}
