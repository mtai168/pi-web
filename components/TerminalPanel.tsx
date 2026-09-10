"use client";

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "@/hooks/useI18n";
import type { TerminalEvent } from "@/lib/terminal-manager";
import type { TerminalTab } from "@/lib/terminal-tab-state";

interface Props {
  tab: TerminalTab;
  active: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
}

export function TerminalPanel({ tab, active, onRestart, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const { id, cwd, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError });
  callbacksRef.current = { onClosed, onCloseError };
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let events: EventSource | null = null;
    let offset: number | undefined;
    let connected = false;
    let exited = false;
    let inputFailed = false;
    setStatus("connecting");
    setError(null);
    setExitCode(null);

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      screenReaderMode: true,
      disableStdin: true,
      theme: {
        background: "#111318", foreground: "#d7dce5", cursor: "#60a5fa",
        selectionBackground: "#365b8a",
        black: "#1d222b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
        brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac",
        brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9", brightWhite: "#ffffff",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      return true;
    });

    const writer = createTerminalWriter(id, (reason) => {
      if (disposed) return;
      inputFailed = true;
      terminal.options.disableStdin = true;
      setError(reason.message);
      setStatus("error");
    });
    writerRef.current = writer;
    const onData = terminal.onData((data) => {
      if (connected && !exited && !inputFailed) writer.write(data);
    });
    const fitAndResize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };
    const onResize = terminal.onResize(({ cols, rows }) => {
      if (connected && !exited && !inputFailed) writer.resize(cols, rows);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    const connect = () => {
      if (disposed || exited || !navigator.onLine) return;
      events?.close();
      const source = new EventSource(`/api/terminal/${encodeURIComponent(id)}/events${offset === undefined ? "" : `?after=${offset}`}`);
      events = source;
      source.onmessage = (message) => {
        if (disposed || source !== events) return;
        let event: TerminalEvent;
        try {
          event = JSON.parse(message.data) as TerminalEvent;
        } catch {
          setError("Invalid terminal event");
          setStatus("error");
          return;
        }
        if (event.type === "output") {
          if (event.reset) {
            // A stale snapshot (older than already-rendered output) must not
            // clear the screen and replay over newer events.
            if (offset === undefined || event.offset >= offset) {
              terminal.reset();
              terminal.write(event.data);
              offset = event.offset;
            }
            return;
          }
          if (offset !== undefined && event.offset <= offset) return;
          terminal.write(event.data);
          offset = event.offset;
        } else if (event.type === "exit" || event.type === "closed") {
          exited = true;
          connected = false;
          terminal.options.disableStdin = true;
          source.close();
          setExitCode(event.type === "exit" ? event.exitCode : null);
          setStatus("exited");
        }
      };
      source.onopen = () => {
        if (disposed || source !== events) return;
        connected = true;
        if (inputFailed) return;
        terminal.options.disableStdin = false;
        setStatus("ready");
        fitAndResize();
        writer.resize(terminal.cols, terminal.rows);
        if (container.offsetWidth && container.offsetHeight) terminal.focus();
      };
      source.onerror = () => {
        if (disposed || source !== events) return;
        connected = false;
        terminal.options.disableStdin = true;
        setStatus(source.readyState === EventSource.CLOSED ? "error" : "connecting");
      };
    };

    startRef.current = (async () => {
      fitAndResize();
      if (restored && reconnectKey === 0) {
        // Restoring a tab must never silently launch a replacement shell.
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
      } else {
        // A user-initiated reconnect may recreate a shell that a server
        // restart or expiry removed; an existing id is reused as-is.
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }),
        });
      }
      connect();
    })().catch((reason: Error) => {
      if (disposed) return;
      setError(reason.message);
      setStatus("error");
    });

    const pageHide = () => {
      connected = false;
      terminal.options.disableStdin = true;
      events?.close();
      if (!exited && !inputFailed) setStatus("connecting");
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("offline", pageHide);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      events?.close();
      void writer.stop();
      resizeObserver.disconnect();
      onData.dispose();
      onResize.dispose();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("online", connect);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, restored, reconnectKey]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!tab.closing) return;
    let cancelled = false;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    void (async () => {
      await startRef.current;
      await writerRef.current?.stop();
      try {
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
      } catch (error) {
        // The server never created this terminal (failed startup): nothing to delete.
        if ((error as { status?: number }).status !== 404) throw error;
      }
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError();
    });
    return () => { cancelled = true; };
  }, [id, tab.closing]);

  return (
    <section className="terminal-panel" aria-label={t("terminal.title")}>
      <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={cwd}>{cwd}</span>
        </div>
        {status === "error" && (
          <button type="button" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
      </header>
      <div>
        {error && <div className="terminal-panel-error" role="alert">{error}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
    </section>
  );
}

// ponytail: bounded input backlog; raise the cap if a legitimately huge paste stalls.
const MAX_QUEUED_INPUT_BODIES = 64;

export async function terminalRequest(path: string, options?: RequestInit): Promise<{ id?: string; cwd?: string }> {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => ({})) as { id?: string; cwd?: string; error?: string };
  if (!response.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return data;
}

export function createTerminalWriter(id: string, onError: (error: Error) => void) {
  let pending = Promise.resolve();
  let stopped = false;
  let queued = 0;
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: Record<string, unknown>) => {
    if (stopped) return;
    if (queued >= MAX_QUEUED_INPUT_BODIES) {
      // A stalled connection must not accumulate unbounded shell input.
      stopped = true;
      onError(new Error("Terminal input backlog exceeded"));
      return;
    }
    queued += 1;
    pending = pending.then(async () => {
      queued -= 1;
      if (stopped) return;
      if (body === bufferedInput) bufferedInput = null;
      await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }).catch((error: Error) => {
      // Delivery is ambiguous after a network error. Never replay shell input.
      stopped = true;
      onError(error);
    });
  };
  return {
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else {
          bufferedInput = { type: "input", data: chunk };
          enqueue(bufferedInput);
        }
      }
    },
    resize(cols: number, rows: number) {
      bufferedInput = null;
      enqueue({ type: "resize", cols, rows });
    },
    stop() { stopped = true; bufferedInput = null; return pending; },
  };
}
