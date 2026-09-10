"use client";

import type { CSSProperties } from "react";

export interface SessionWallEmptyPaneProps {
  onSelect?: () => void;
  label?: string;
  description?: string;
  ariaLabel?: string;
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SessionWallEmptyPane({
  onSelect,
  label = "Select session",
  description = "Choose a session for this pane.",
  ariaLabel = "Empty session pane",
}: SessionWallEmptyPaneProps) {
  const buttonStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 32,
    minWidth: 0,
    padding: "5px 10px",
    border: "1px dashed var(--border)",
    borderRadius: 5,
    background: "transparent",
    color: "var(--text-muted)",
    cursor: onSelect ? "pointer" : "default",
    font: "inherit",
    fontSize: 12,
  };

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minWidth: 0,
        minHeight: "100%",
        padding: 16,
        color: "var(--text-muted)",
        textAlign: "center",
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={!onSelect}
        title={label}
        aria-label={label}
        style={buttonStyle}
        onMouseEnter={(event) => {
          if (onSelect) event.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = "transparent";
        }}
      >
        <PlusIcon />
        <span>{label}</span>
      </button>
      {description && (
        <span style={{ maxWidth: 280, fontSize: 11, lineHeight: 1.45 }}>
          {description}
        </span>
      )}
    </div>
  );
}
