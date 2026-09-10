"use client";

import { useEffect } from "react";
import {
  invokeFocusedSessionAction,
  isSessionActionRoutingEnabled,
} from "../lib/session-wall/focus-actions";

let legacyAbortHandler: (() => void) | null = null;

export function registerAbortHandler(handler: (() => void) | null): void {
  legacyAbortHandler = handler;
}

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

export function handleGlobalKeyboardShortcut(
  e: KeyboardEvent,
  { onNewSession, activeCwd }: UseGlobalKeyboardShortcutsOptions = {},
): void {
  if (e.key === "Escape") {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || target?.isContentEditable) return;

    if (isSessionActionRoutingEnabled() && invokeFocusedSessionAction()) {
      e.preventDefault();
      return;
    }

    if (!legacyAbortHandler) return;
    e.preventDefault();
    legacyAbortHandler();
    return;
  }

  if (e.key === "n" && e.ctrlKey && e.altKey) {
    if (!activeCwd || !onNewSession) return;
    e.preventDefault();
    onNewSession(activeCwd);
  }
}

export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      handleGlobalKeyboardShortcut(e, { onNewSession, activeCwd });
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession]);
}
