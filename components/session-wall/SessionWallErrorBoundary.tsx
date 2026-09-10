"use client";

import { Component, Fragment, type ReactNode } from "react";

export interface SessionWallErrorBoundaryLabels {
  title: string;
  description: string;
  retry: string;
  replace: string;
  remove: string;
}

export const DEFAULT_SESSION_WALL_ERROR_LABELS: SessionWallErrorBoundaryLabels = Object.freeze({
  title: "Pane content unavailable",
  description: "This pane could not render its content. The session may still be running.",
  retry: "Retry",
  replace: "Replace",
  remove: "Remove",
});

export interface SessionWallErrorBoundaryProps {
  children: ReactNode;
  resetKey?: string | number | null;
  paneId?: string;
  sessionId?: string | null;
  paneLabel?: string;
  labels?: Partial<SessionWallErrorBoundaryLabels>;
  onRetry?: () => void;
  onReplace?: () => void;
  onRemove?: () => void;
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface SessionWallErrorBoundaryState {
  error: Error | null;
  retryVersion: number;
}

function ActionIcon({ kind }: { kind: "retry" | "replace" | "remove" }) {
  if (kind === "retry") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0 2 5" />
        <path d="M20 4v7h-7" />
      </svg>
    );
  }
  if (kind === "replace") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7h13" />
        <path d="m12 3 4 4-4 4" />
        <path d="M21 17H8" />
        <path d="m12 13-4 4 4 4" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="m6 7 1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

function RecoveryAction({
  label,
  kind,
  onClick,
}: {
  label: string;
  kind: "retry" | "replace" | "remove";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        minHeight: 27,
        padding: "4px 8px",
        border: "1px solid var(--border)",
        borderRadius: 4,
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        cursor: "pointer",
        font: "inherit",
        fontSize: 11,
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "var(--bg-hover)";
        event.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "var(--bg-panel)";
        event.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      <ActionIcon kind={kind} />
      <span>{label}</span>
    </button>
  );
}

export class SessionWallErrorBoundary extends Component<
  SessionWallErrorBoundaryProps,
  SessionWallErrorBoundaryState
> {
  state: SessionWallErrorBoundaryState = { error: null, retryVersion: 0 };

  static getDerivedStateFromError(error: Error): Pick<SessionWallErrorBoundaryState, "error"> {
    return { error };
  }

  componentDidUpdate(previousProps: SessionWallErrorBoundaryProps): void {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState(({ retryVersion }) => ({ error: null, retryVersion: retryVersion + 1 }));
    }
  }

  private retry = (): void => {
    this.setState(({ retryVersion }) => ({ error: null, retryVersion: retryVersion + 1 }));
    this.props.onRetry?.();
  };

  private renderRecovery(error: Error): ReactNode {
    const { labels: labelOverrides, fallback } = this.props;
    const labels = { ...DEFAULT_SESSION_WALL_ERROR_LABELS, ...labelOverrides };
    if (fallback) return fallback(error, this.retry);

    const paneLabel = this.props.paneLabel?.trim()
      || this.props.paneId?.trim()
      || (this.props.sessionId ? `Session ${this.props.sessionId}` : "Session pane");

    return (
      <div
        role="alert"
        aria-label={`${labels.title}: ${paneLabel}`}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          gap: 7,
          minWidth: 0,
          minHeight: "100%",
          padding: "14px 16px",
          color: "var(--text-muted)",
        }}
      >
        <strong style={{ color: "var(--text)", fontSize: 12 }}>{labels.title}</strong>
        <span style={{ maxWidth: "100%", fontSize: 11, lineHeight: 1.45 }}>
          {paneLabel}: {labels.description}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <RecoveryAction label={labels.retry} kind="retry" onClick={this.retry} />
          {this.props.onReplace && <RecoveryAction label={labels.replace} kind="replace" onClick={this.props.onReplace} />}
          {this.props.onRemove && <RecoveryAction label={labels.remove} kind="remove" onClick={this.props.onRemove} />}
        </div>
      </div>
    );
  }

  render(): ReactNode {
    if (this.state.error) return this.renderRecovery(this.state.error);
    return <Fragment key={this.state.retryVersion}>{this.props.children}</Fragment>;
  }
}
