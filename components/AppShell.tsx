"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import {
  ChatWindow,
  countCurrentWallAttentionReports,
  isCurrentBrainStatusReport,
  type BrainStatusPaneIdentity,
  type BrainStatusReport,
} from "./ChatWindow";
import { SessionWall } from "./session-wall/SessionWall";
import { SessionWallChatWindow } from "./session-wall/SessionWallChatWindow";
import { createOuterScrollSourceRegistry } from "./session-wall/SessionWall";
import { SessionWallPicker } from "./session-wall/SessionWallPicker";
import { SessionWallToolbar } from "./session-wall/SessionWallToolbar";
import { getSessionWallPaneRuntimeKey, type SessionWallPaneRenderContext } from "./session-wall/SessionWallPane";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { openFileTab, saveFileViewerState } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile, useIsNarrowMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";
import { getInitialNavigation } from "@/lib/initial-navigation";
import {
  clearLastOpen,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { ToolEntry } from "@/lib/tool-presets";
import { getSessionFamily } from "@/lib/session-family";
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";
import { createSystemInfoLoaderController, type SystemInfoLoader, type SystemInfoLoaderController } from "@/lib/session-wall/system-info-loader";
import { createSessionWallToolbarOwnership, createSessionWallToolbarReporterController, getSessionWallToolbarOwnerKey } from "@/lib/session-wall/toolbar-ownership";
import { loadSessionWalls, saveSessionWalls } from "@/lib/session-wall/store";
import { sessionWallReducer, type SessionWallAction } from "@/lib/session-wall/reducer";
import type { SessionWallConfigV1, SessionWallPaneConfig, SessionWallsStoreV1 } from "@/lib/session-wall/types";
import { useSessionWallFocus, type SessionWallFocusIdentity, type SessionWallFocusToken } from "@/hooks/useSessionWallFocus";
import { rekeyDraft } from "@/lib/draft-store";
import { sendAgentCommand } from "@/lib/agent-client";
import { TerminalPanel } from "./TerminalPanel";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "@/lib/terminal-tab-state";
import type { ChatScrollPosition } from "@/lib/chat-scroll-position";
import type { SessionCatalogRefreshState } from "@/hooks/useSessionCatalog";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";
type WorkspaceMode = "normal" | "wall";
type PreWallPanelState = { sidebarOpen: boolean; rightPanelOpen: boolean };
type WallBlockingAttention = BrainStatusPaneIdentity;
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;
const AGENT_PANEL_WIDTH = 420;
const WORKSPACE_MODE_STORAGE_KEY = "pi-web:workspace-mode:v1";

function parkedNewSessionDraftKey(cwd: string): string {
  return `parked-new:${cwd}`;
}

function readWorkspaceModePreference(): WorkspaceMode {
  if (typeof window === "undefined") return "normal";
  try {
    return window.localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY) === "wall" ? "wall" : "normal";
  } catch {
    return "normal";
  }
}

function saveWorkspaceModePreference(mode: WorkspaceMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_MODE_STORAGE_KEY, mode);
  } catch {
    // Mode persistence is best-effort.
  }
}

// Mirrors hooks/useIsMobile's breakpoint; reads the real viewport directly so
// mode hydration is correct before useSyncExternalStore's client snapshot lands.
function matchesMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
}

function getSessionWallFocusIdentity(
  pane: Pick<SessionWallPaneConfig, "paneId" | "sessionId" | "runtimeRevision">,
): SessionWallFocusIdentity | null {
  return pane.sessionId
    ? { paneId: pane.paneId, sessionId: pane.sessionId, runtimeRevision: pane.runtimeRevision ?? 0 }
    : null;
}

function addAndFocusSessionWall(
  wall: SessionWallConfigV1,
  sessionId: string,
  updatedAt: string,
): SessionWallConfigV1 {
  const existing = wall.panes.find((pane) => pane.sessionId === sessionId);
  const nextWall = existing
    ? wall
    : sessionWallReducer(wall, {
      type: "add",
      sessionId,
      updatedAt,
    });
  const target = nextWall.panes.find((pane) => pane.sessionId === sessionId);
  return target
    ? sessionWallReducer(nextWall, {
      type: "focus",
      paneId: target.paneId,
      updatedAt,
    })
    : nextWall;
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { preference, toggleTheme } = useTheme();
  const themeLabelKey =
    preference === "light" ? "theme.light" : preference === "dark" ? "theme.dark" : "theme.auto";
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const hasExplicitInitialNavigation = initialNavigation.sessionId !== null
    || initialNavigation.requestedCwd !== null;
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("normal");
  const workspaceModeRef = useRef(workspaceMode);
  workspaceModeRef.current = workspaceMode;
  const workspacePreferenceLoadedRef = useRef(false);
  const persistedWallEntryPendingRef = useRef(false);
  const [workspacePreferenceHydrated, setWorkspacePreferenceHydrated] = useState(false);
  const isMobile = useIsMobile();
  const isNarrowMobile = useIsNarrowMobile();
  useViewportHeight();

  // Once the user has granted notification permission, register a Web Push
  // subscription so the server can notify backgrounded PWAs (notably iOS,
  // which suspends page JS and never receives the SSE completion event).
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    void setupPushSubscription(locale);
  }, [locale]);
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true");
    } catch {
      // Browser storage is best-effort.
    }
  }, []);
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback(() => {
    if (soundEnabledRef.current) playDoneSound();
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const [sessionCatalogReady, setSessionCatalogReady] = useState(false);
  const [sessionWallRefreshKey, setSessionWallRefreshKey] = useState(0);
  const [sessionWallRefreshState, setSessionWallRefreshState] = useState<SessionCatalogRefreshState>({
    generation: 0,
    pending: false,
    done: false,
    error: null,
  });
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
    setSessionCatalogReady(true);
  }, []);
  const [sessionWalls, setSessionWalls] = useState<SessionWallsStoreV1 | null>(null);
  const [sessionWallHydrated, setSessionWallHydrated] = useState(false);
  const sessionWallSavedValueRef = useRef<SessionWallsStoreV1 | null>(null);
  useLayoutEffect(() => {
    setSessionWalls(loadSessionWalls());
    setSessionWallHydrated(true);
  }, []);
  useEffect(() => {
    if (!sessionWallHydrated || !sessionWalls) return;
    if (sessionWallSavedValueRef.current === null) {
      sessionWallSavedValueRef.current = sessionWalls;
      return;
    }
    if (sessionWallSavedValueRef.current === sessionWalls) return;
    sessionWallSavedValueRef.current = sessionWalls;
    saveSessionWalls(sessionWalls);
  }, [sessionWallHydrated, sessionWalls]);
  const [wallViewport, setWallViewport] = useState({ width: 0, height: 0 });
  const wallViewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let frameId: number | null = null;
    let zeroSizeAttempts = 0;
    const measure = () => {
      frameId = null;
      const element = wallViewportRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        if (zeroSizeAttempts < 4) {
          zeroSizeAttempts += 1;
          frameId = window.requestAnimationFrame(measure);
        }
        return;
      }
      zeroSizeAttempts = 0;
      setWallViewport((previous) => (
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height }
      ));
    };
    const schedule = () => {
      zeroSizeAttempts = 0;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = typeof ResizeObserver === "undefined" || !wallViewportRef.current
      ? null
      : new ResizeObserver(schedule);
    if (observer && wallViewportRef.current) observer.observe(wallViewportRef.current);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [sessionWallHydrated, workspaceMode, workspacePreferenceHydrated]);
  const sessionsWithSelection = useMemo(() => {
    if (!selectedSession) return sessionCatalog;
    return [
      ...sessionCatalog.filter((session) => session.id !== selectedSession.id),
      selectedSession,
    ];
  }, [selectedSession, sessionCatalog]);
  const sessionById = useMemo(
    () => new Map(sessionsWithSelection.map((session) => [session.id, session])),
    [sessionsWithSelection],
  );
  const activeSessionWall = useMemo(() => {
    if (!sessionWalls) return null;
    return sessionWalls.walls.find((wall) => wall.wallId === sessionWalls.activeWallId)
      ?? sessionWalls.walls[0]
      ?? null;
  }, [sessionWalls]);
  const activeSessionWallRef = useRef<SessionWallConfigV1 | null>(null);
  activeSessionWallRef.current = activeSessionWall;
  const activeSessionWallId = activeSessionWall?.wallId ?? null;
  const acceptsWallPaneCallback = useCallback((
    capturedPane: SessionWallPaneConfig,
    capturedWallId: string | null,
    capturedRuntimeKey: string,
  ) => {
    if (workspaceModeRef.current !== "wall" || !capturedWallId) return false;
    if (getSessionWallPaneRuntimeKey(capturedPane) !== capturedRuntimeKey) return false;
    const wall = activeSessionWallRef.current;
    if (!wall || wall.wallId !== capturedWallId) return false;
    const currentPane = wall.panes.find((candidate) => candidate.paneId === capturedPane.paneId);
    if (!currentPane || currentPane.sessionId !== capturedPane.sessionId) return false;
    if ((currentPane.runtimeRevision ?? 0) !== (capturedPane.runtimeRevision ?? 0)) return false;
    return getSessionWallPaneRuntimeKey(currentPane) === capturedRuntimeKey;
  }, []);
  const focusedWallPane = activeSessionWall?.panes.find((pane) => (
    pane.paneId === activeSessionWall.focusedPaneId && pane.sessionId !== null
  )) ?? null;
  const focusedWallSession = focusedWallPane?.sessionId
    ? sessionById.get(focusedWallPane.sessionId) ?? null
    : null;
  const [sessionWallPickerOpen, setSessionWallPickerOpen] = useState(false);
  const [sessionWallPickerMode, setSessionWallPickerMode] = useState<"add" | "replace">("add");
  const [sessionWallPickerPaneId, setSessionWallPickerPaneId] = useState<string | null>(null);
  const sessionWallPickerOpenRef = useRef(false);
  const sessionWallPickerViewRef = useRef(0);
  const sessionWallPickerRefreshBindingRef = useRef<{ view: number; generation: number } | null>(null);
  const sessionWallPickerRefreshAwaitingViewRef = useRef<number | null>(null);
  const wallFocus = useSessionWallFocus({
    enabled: workspaceMode === "wall" && sessionWallHydrated,
    paneId: focusedWallPane?.paneId,
    sessionId: focusedWallSession?.id,
    runtimeRevision: focusedWallPane?.runtimeRevision ?? 0,
  });
  const focusedWallIdentityKey = getSessionWallToolbarOwnerKey(
    focusedWallPane && focusedWallSession
      ? {
          paneId: focusedWallPane.paneId,
          sessionId: focusedWallSession.id,
          runtimeRevision: focusedWallPane.runtimeRevision ?? 0,
        }
      : null,
  );
  const wallToolbarOwnershipRef = useRef(createSessionWallToolbarOwnership());
  const [, setWallToolbarOwnerRenderVersion] = useState(0);
  const toolbarSession = workspaceMode === "wall" ? focusedWallSession : selectedSession;
  const toolbarSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, toolbarSession?.id),
    [toolbarSession?.id, sessionsWithSelection],
  );
  const hasSubagentSessions = Boolean(toolbarSessionFamily?.subagents.length);
  const activeToolbarSessionIdRef = useRef<string | null>(toolbarSession?.id ?? null);
  activeToolbarSessionIdRef.current = toolbarSession?.id ?? null;
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [wallBrainStatusReports, setWallBrainStatusReports] = useState<Record<string, BrainStatusReport>>({});
  const [wallBlockingAttention, setWallBlockingAttention] = useState<Record<string, WallBlockingAttention>>({});
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  const handleWallBrainStatusReport = useCallback((report: BrainStatusReport) => {
    if (workspaceModeRef.current !== "wall") return;
    const wall = activeSessionWallRef.current;
    const pane = wall?.panes.find((candidate) => candidate.paneId === report.paneId);
    if (!wall || !pane) return;
    const identity: BrainStatusPaneIdentity = {
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      runtimeKey: getSessionWallPaneRuntimeKey(pane),
      wallId: wall.wallId,
    };
    if (!isCurrentBrainStatusReport(report, identity)) return;
    setWallBrainStatusReports((previous) => {
      const current = previous[pane.paneId];
      if (
        current
        && current.sessionId === report.sessionId
        && current.runtimeKey === report.runtimeKey
        && current.wallId === report.wallId
        && current.status === report.status
        && current.stale === report.stale
      ) return previous;
      return { ...previous, [pane.paneId]: report };
    });
  }, []);
  const handleWallBlockingAttention = useCallback((identity: BrainStatusPaneIdentity, blocking: boolean) => {
    const isCurrent = () => {
      if (workspaceModeRef.current !== "wall" || !identity.wallId) return false;
      const wall = activeSessionWallRef.current;
      const pane = wall?.panes.find((candidate) => candidate.paneId === identity.paneId);
      return Boolean(
        wall
        && wall.wallId === identity.wallId
        && pane
        && pane.sessionId === identity.sessionId
        && getSessionWallPaneRuntimeKey(pane) === identity.runtimeKey
      );
    };
    if (blocking && !isCurrent()) return;
    setWallBlockingAttention((previous) => {
      const current = previous[identity.paneId];
      const matches = current
        && current.sessionId === identity.sessionId
        && current.runtimeKey === identity.runtimeKey
        && current.wallId === identity.wallId;
      if (blocking) {
        if (!isCurrent() || matches) return previous;
        return { ...previous, [identity.paneId]: identity };
      }
      if (!matches) return previous;
      const next = { ...previous };
      delete next[identity.paneId];
      return next;
    });
  }, []);
  const getSessionWallPaneBlockingAttention = useCallback((pane: SessionWallPaneConfig) => {
    const attention = wallBlockingAttention[pane.paneId];
    return Boolean(
      attention
      && attention.wallId === activeSessionWallId
      && attention.sessionId === pane.sessionId
      && attention.runtimeKey === getSessionWallPaneRuntimeKey(pane)
    );
  }, [activeSessionWallId, wallBlockingAttention]);
  const wallBrainStatusIdentities: BrainStatusPaneIdentity[] = activeSessionWall
    ? activeSessionWall.panes.map((pane) => ({
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      runtimeKey: getSessionWallPaneRuntimeKey(pane),
      wallId: activeSessionWallId,
    }))
    : [];
  const wallAttentionCount = countCurrentWallAttentionReports(wallBrainStatusIdentities, wallBrainStatusReports);
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatScrollPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current === target ? null : current);
  }, []);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const preWallPanelStateRef = useRef<PreWallPanelState | null>(null);
  const normalSessionToRestoreRef = useRef<SessionInfo | null>(null);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useLayoutEffect(() => {
    if (workspacePreferenceLoadedRef.current) return;
    workspacePreferenceLoadedRef.current = true;
    const initialMode: WorkspaceMode = hasExplicitInitialNavigation || matchesMobileViewport()
      ? "normal"
      : readWorkspaceModePreference();

    persistedWallEntryPendingRef.current = initialMode === "wall";
    if (initialMode === "wall") {
      preWallPanelStateRef.current = {
        sidebarOpen: isMobile ? false : sidebarOpen,
        rightPanelOpen,
      };
      setSidebarOpen(false);
      setRightPanelOpen(false);
    }
    setWorkspaceMode(initialMode);
    setWorkspacePreferenceHydrated(true);
  }, [hasExplicitInitialNavigation, isMobile, rightPanelOpen, sidebarOpen]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  const languageBtnRef = useRef<HTMLButtonElement>(null);

  const updateActiveSessionWall = useCallback((update: (wall: SessionWallConfigV1) => SessionWallConfigV1) => {
    setSessionWalls((currentStore) => {
      if (!currentStore) return currentStore;
      const index = currentStore.walls.findIndex((wall) => wall.wallId === currentStore.activeWallId);
      if (index < 0) return currentStore;
      const currentWall = currentStore.walls[index];
      const nextWall = update(currentWall);
      if (nextWall === currentWall) return currentStore;
      const walls = [...currentStore.walls];
      walls[index] = nextWall;
      return { ...currentStore, walls };
    });
  }, []);

  useEffect(() => {
    if (!persistedWallEntryPendingRef.current || !workspacePreferenceHydrated || !sessionWallHydrated) return;
    if (workspaceMode !== "wall") {
      persistedWallEntryPendingRef.current = false;
      return;
    }
    if (!selectedSession?.id) return;
    persistedWallEntryPendingRef.current = false;
    const sessionId = selectedSession.id;
    const updatedAt = new Date().toISOString();
    updateActiveSessionWall((wall) => addAndFocusSessionWall(wall, sessionId, updatedAt));
  }, [selectedSession?.id, sessionWallHydrated, updateActiveSessionWall, workspaceMode, workspacePreferenceHydrated]);

  const outerScrollRegistryRef = useRef(createOuterScrollSourceRegistry());
  const handleOuterScrollSourceChange = useCallback((wallId: string, sourceId: object, active: boolean) => {
    const registry = outerScrollRegistryRef.current;
    if (active) registry.register(wallId, sourceId);
    else registry.unregister(wallId, sourceId);
  }, []);

  const handleWallOuterScrollTopChange = useCallback((wallId: string, outerScrollTop: number, sourceId: object, transitionFlush = false) => {
    if (!Number.isFinite(outerScrollTop) || outerScrollTop < 0) return;
    const registry = outerScrollRegistryRef.current;
    const claim = registry.acceptClaim(wallId, sourceId, transitionFlush);
    if (claim === null) return;
    setSessionWalls((currentStore) => {
      if (!currentStore) return currentStore;
      if (!registry.isValidClaim(wallId, sourceId, claim)) return currentStore;
      const index = currentStore.walls.findIndex((wall) => wall.wallId === wallId);
      if (index < 0) return currentStore;
      const currentWall = currentStore.walls[index];
      if (currentWall.outerScrollTop === outerScrollTop) return currentStore;
      const walls = [...currentStore.walls];
      walls[index] = {
        ...currentWall,
        outerScrollTop,
      };
      return { ...currentStore, walls };
    });
  }, []);

  const dispatchSessionWallAction = useCallback((action: SessionWallAction) => {
    updateActiveSessionWall((wall) => sessionWallReducer(wall, {
      ...action,
      updatedAt: action.updatedAt ?? new Date().toISOString(),
    }));
  }, [updateActiveSessionWall]);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderControllerRef = useRef<SystemInfoLoaderController | null>(null);
  if (systemInfoLoaderControllerRef.current === null) {
    systemInfoLoaderControllerRef.current = createSystemInfoLoaderController();
  }
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleSystemInfoLoaderChange = useCallback((loader: SystemInfoLoader | null) => {
    // Callback-prop churn re-runs the reporting effect: its cleanup reports
    // null and the body re-reports the same loader. The controller ignores
    // the null (the loader is only cleared by clearWallToolbarState on real
    // focus/mode changes or by the ready-state effect below) and skips
    // same-reference re-registrations, so ordinary re-renders never touch
    // loading state or invalidate an in-flight load.
    if (systemInfoLoaderControllerRef.current?.register(loader)) setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);
  const wallToolbarReporterController = useMemo(
    () => createSessionWallToolbarReporterController({
      acceptsOwner: (ownerKey) => wallToolbarOwnershipRef.current.accepts(ownerKey),
      onSessionStatsChange: handleSessionStatsChange,
      onContextUsageChange: handleContextUsageChange,
    }),
    [handleContextUsageChange, handleSessionStatsChange],
  );

  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "system" | "tools" | "session" | "language" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const clearWallToolbarState = useCallback(() => {
    setBranchTree([]);
    setBranchActiveLeafId(null);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    systemInfoLoaderControllerRef.current?.clear();
    setSystemInfoLoading(false);
    setSessionStats(null);
    setContextUsage(null);
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
    setActiveTopPanel(null);
  }, []);

  const handleWallFocus = useCallback((pane: SessionWallPaneConfig) => {
    const identity = getSessionWallFocusIdentity(pane);
    if (!identity || wallFocus.isCurrent(identity)) return;
    clearWallToolbarState();
    dispatchSessionWallAction({ type: "focus", paneId: pane.paneId });
  }, [clearWallToolbarState, dispatchSessionWallAction, wallFocus]);

  useLayoutEffect(() => {
    const nextOwnerKey = workspaceMode === "wall" ? focusedWallIdentityKey : null;
    if (!wallToolbarOwnershipRef.current.transition(nextOwnerKey)) return;
    setWallToolbarOwnerRenderVersion((version) => version + 1);
    clearWallToolbarState();
  }, [clearWallToolbarState, focusedWallIdentityKey, workspaceMode]);

  useLayoutEffect(() => {
    const activeReporterKeys = new Set<string>();
    if (workspaceMode === "wall" && activeSessionWall) {
      for (const pane of activeSessionWall.panes) {
        if (!pane.sessionId) continue;
        const ownerKey = getSessionWallToolbarOwnerKey({
          paneId: pane.paneId,
          sessionId: pane.sessionId,
          runtimeRevision: pane.runtimeRevision ?? 0,
        });
        if (ownerKey) activeReporterKeys.add(ownerKey);
      }
    }
    wallToolbarReporterController.prune(activeReporterKeys);
  }, [activeSessionWall, wallToolbarReporterController, workspaceMode]);

  // The focused pane's ChatWindow unmounts when its pane leaves the ready
  // state (stale/error/loading) or the session leaves the catalog; clear its
  // loader so the toolbar never invokes a loader from an unmounted pane.
  useEffect(() => {
    if (workspaceMode !== "wall" || !activeSessionWall) return;
    const focusedPane = activeSessionWall.panes.find((pane) => pane.paneId === activeSessionWall.focusedPaneId);
    const ready = focusedPane?.sessionId !== null
      && focusedPane?.sessionId !== undefined
      && sessionCatalogReady
      && sessionById.has(focusedPane.sessionId);
    if (ready || systemInfoLoaderControllerRef.current === null) return;
    systemInfoLoaderControllerRef.current.clear();
    setSystemInfoLoading(false);
  }, [activeSessionWall, sessionById, sessionCatalogReady, workspaceMode]);

  const handleWorkspaceModeChange = useCallback((nextMode: WorkspaceMode) => {
    if (nextMode === workspaceMode) return;
    if (nextMode === "wall" && isMobile) return;

    if (nextMode === "wall") {
      normalSessionToRestoreRef.current = null;
      clearWallToolbarState();
      preWallPanelStateRef.current = { sidebarOpen, rightPanelOpen };
      if (selectedSession) {
        const updatedAt = new Date().toISOString();
        updateActiveSessionWall((wall) => addAndFocusSessionWall(wall, selectedSession.id, updatedAt));
      }
      setSidebarOpen(false);
      setRightPanelOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    } else {
      normalSessionToRestoreRef.current = normalSessionToRestoreRef.current ?? focusedWallSession;
      clearWallToolbarState();
      const previous = preWallPanelStateRef.current;
      setSidebarOpen(isMobile ? false : previous?.sidebarOpen ?? false);
      setRightPanelOpen(previous?.rightPanelOpen ?? false);
      preWallPanelStateRef.current = null;
    }

    setWorkspaceMode(nextMode);
    saveWorkspaceModePreference(nextMode);
  }, [clearWallToolbarState, focusedWallSession, isMobile, rightPanelOpen, selectedSession, sidebarOpen, updateActiveSessionWall, workspaceMode]);

  // Wall is unavailable at the mobile breakpoint: leave it when the viewport
  // crosses into mobile so normal mode stays usable. Declared after the mode
  // change handler so the exit runs before any pending Wall entry effect.
  useEffect(() => {
    if (isMobile && workspaceMode === "wall") {
      handleWorkspaceModeChange("normal");
    }
  }, [handleWorkspaceModeChange, isMobile, workspaceMode]);

  // Single active panel — only one dropdown open at a time

  useEffect(() => {
    if (!sessionHasBranches) {
      setActiveTopPanel((panel) => panel === "branches" ? null : panel);
    }
  }, [sessionHasBranches]);

  useEffect(() => {
    if (!hasSubagentSessions) {
      setActiveTopPanel((panel) => panel === "agents" ? null : panel);
    }
  }, [hasSubagentSessions]);

  const toggleTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session" | "language",
    keepMobileToolbarOpen = false,
  ) => {
    if (workspaceModeRef.current === "wall") return;
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile]);

  const handleSystemInfoToggle = useCallback((
    panel: "system" | "tools",
    keepMobileToolbarOpen = false,
  ) => {
    if (workspaceMode === "wall") return;
    const opening = activeTopPanel !== panel;
    toggleTopPanel(panel, keepMobileToolbarOpen);
    const started = systemInfoLoaderControllerRef.current?.start(opening);
    if (!started) return;
    setSystemInfoLoading(true);
    void started.load(started.signal).catch((error) => {
      // Abort-induced rejections (the run's signal is on the ensure_session
      // fetch) are cancellation noise; genuine failures still surface even
      // when the run was superseded.
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoaderControllerRef.current?.complete(started.loadId)) {
        setSystemInfoLoading(false);
      }
    });
  }, [activeTopPanel, toggleTopPanel, workspaceMode]);

  const openSessionStatsPanel = useCallback(() => {
    if (workspaceMode === "wall") return;
    if (isMobile) setSidebarOpen(false);
    setMobileToolbarMoreOpen(false);
    setActiveTopPanel("session");
  }, [isMobile, workspaceMode]);

  const handleSidebarToggle = useCallback(() => {
    if (workspaceMode === "wall") return;
    if (isMobile) {
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile, workspaceMode]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    if (workspaceMode === "wall") return;
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, [workspaceMode]);

  const handleRightPanelToggle = useCallback(() => {
    if (workspaceMode === "wall") return;
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile, workspaceMode]);

  const toggleWallTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session" | "language",
    keepMobileToolbarOpen = false,
  ) => {
    if (!toolbarSession) return;
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile, toolbarSession]);

  const handleWallSystemInfoToggle = useCallback((
    panel: "system" | "tools",
    keepMobileToolbarOpen = false,
  ) => {
    if (!toolbarSession) return;
    const opening = activeTopPanel !== panel;
    toggleWallTopPanel(panel, keepMobileToolbarOpen);
    const started = systemInfoLoaderControllerRef.current?.start(opening);
    if (!started) return;
    setSystemInfoLoading(true);
    void started.load(started.signal).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoaderControllerRef.current?.complete(started.loadId)) setSystemInfoLoading(false);
    });
  }, [activeTopPanel, toggleWallTopPanel, toolbarSession]);

  // Normal-mode callback forms remain onClick={() => handleSystemInfoToggle("system", mobile)} and onClick={() => handleSystemInfoToggle("tools", mobile)}.
  const toggleToolbarTopPanel = workspaceMode === "wall" ? toggleWallTopPanel : toggleTopPanel;
  const handleToolbarSystemInfoToggle = workspaceMode === "wall"
    ? handleWallSystemInfoToggle
    : handleSystemInfoToggle;
  const openWallSessionStatsPanel = useCallback(() => {
    if (!toolbarSession) return;
    setActiveTopPanel("session");
  }, [toolbarSession]);

  // The normal ChatWindow is unmounted while Wall owns its pane runtimes.
  // Its cleanup reports are still mode-guarded during the transition.
  const handleNormalBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    if (workspaceModeRef.current !== "normal") return;
    handleBranchDataChange(tree, activeLeafId, onLeafChange);
  }, [handleBranchDataChange]);
  const handleNormalSystemPromptChange = useCallback((prompt: string | null) => {
    if (workspaceModeRef.current !== "normal") return;
    handleSystemPromptChange(prompt);
  }, [handleSystemPromptChange]);
  const handleNormalSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    if (workspaceModeRef.current !== "normal") return;
    handleSystemToolsChange(tools);
  }, [handleSystemToolsChange]);
  const handleNormalSystemInfoLoaderChange = useCallback((loader: SystemInfoLoader | null) => {
    if (workspaceModeRef.current !== "normal") return;
    handleSystemInfoLoaderChange(loader);
  }, [handleSystemInfoLoaderChange]);
  const handleNormalSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    if (workspaceModeRef.current !== "normal") return;
    handleSessionStatsChange(stats);
  }, [handleSessionStatsChange]);
  const handleNormalSessionStatsPanelOpen = useCallback(() => {
    if (workspaceModeRef.current !== "normal") return;
    openSessionStatsPanel();
  }, [openSessionStatsPanel]);
  const handleNormalContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    if (workspaceModeRef.current !== "normal") return;
    handleContextUsageChange(usage);
  }, [handleContextUsageChange]);

  useEffect(() => {
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || workspaceMode === "wall") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || target?.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [mobileToolbarMoreOpen, workspaceMode]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
  }, [isMobile, isNarrowMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "language" && !isMobile && languageBtnRef.current) {
        const buttonRect = languageBtnRef.current.getBoundingClientRect();
        const width = Math.min(LANGUAGE_MENU_WIDTH, topBarRect.width);
        const left = Math.min(
          buttonRect.left - 1,
          Math.max(topBarRect.left, topBarRect.right - width),
        );
        setTopPanelPos({ top: topBarRect.bottom, left, width });
        return;
      }
      if (activeTopPanel === "agents") {
        setTopPanelPos({
          top: topBarRect.bottom,
          left: topBarRect.left,
          width: Math.min(AGENT_PANEL_WIDTH, topBarRect.width),
        });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    if (languageBtnRef.current) ro.observe(languageBtnRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [fileTabCwds, setFileTabCwds] = useState<Record<string, string>>({});
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  // Files unmount when inactive; workspace terminals stay mounted until closed.
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  const panelTabs: Tab[] = [...fileTabs, ...terminalTabs.map((tab) => ({
    id: tab.id,
    label: getFileName(tab.cwd) || tab.cwd,
    filePath: tab.cwd,
  }))];

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.activeId) {
        setActiveFileTabId(saved.activeId);
        setRightPanelOpen(saved.open);
      } else if (saved.tabs.length > 0 && saved.open) {
        // The remembered active tab is gone; keep the panel open on the last tab.
        setActiveFileTabId(saved.tabs[saved.tabs.length - 1].id);
        setRightPanelOpen(true);
      }
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeFileTabId,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeFileTabId, rightPanelOpen, terminalsRestored]);

  useEffect(() => {
    if (rightPanelOpen && fileTabs.length === 0 && terminalTabs.length === 0) setRightPanelOpen(false);
  }, [rightPanelOpen, fileTabs.length, terminalTabs.length]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
  }, []);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectKey
      ?? activeProjectKeyRef.current
      ?? workspaceKeyOf(selectedSession);
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        const draftId = `initial:${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string, cwd: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if (workspaceKeyOf(s) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        // Keep the temporary composer's draft in its cwd, even when the
        // remembered session belongs to another worktree of this project.
        const activeDraftKey = activeNewSessionDraftKeyRef.current;
        if (activeDraftKey) {
          rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(cwd));
        }
        activeNewSessionDraftKeyRef.current = null;
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          router.replace(`?session=${encodeURIComponent(s.id)}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    invalidateWorkspaceRestore();
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    const previousDraftKey = activeNewSessionDraftKeyRef.current;
    if (previousDraftKey && currentFreshCwd) {
      rekeyDraft(previousDraftKey, parkedNewSessionDraftKey(currentFreshCwd));
    }
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const draftKey = `new:${draftId}:${cwd}`;
    rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = draftKey;
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (currentProject !== newProject) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);
      setFileTabCwds({});
      if (!activeFileTabId || activeFileTabId.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      restoreWorkspaceContext(newProject, cwd);
    }
    router.replace("/", { scroll: false });
  }, [activeCwd, activeFileTabId, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false, entryId?: string, blockIndex?: number) => {
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    invalidateWorkspaceRestore();
    const activeDraftKey = activeNewSessionDraftKeyRef.current;
    const activeDraftCwd = newSessionCwd ?? (selectedSession === null ? activeCwd : null);
    if (activeDraftKey && activeDraftCwd) {
      rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd));
    }
    activeNewSessionDraftKeyRef.current = null;
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [activeCwd, invalidateWorkspaceRestore, newSessionCwd, router, isMobile, selectedSession]);

  const handleWallAgentSessionSelect = useCallback((session: SessionInfo) => {
    if (workspaceMode !== "wall" || !activeSessionWall || !session.id) return;
    const pane = activeSessionWall.panes.find((candidate) => candidate.sessionId === session.id);
    if (pane) {
      handleWallFocus(pane);
      return;
    }
    normalSessionToRestoreRef.current = session;
    handleWorkspaceModeChange("normal");
  }, [activeSessionWall, handleWallFocus, handleWorkspaceModeChange, workspaceMode]);

  const handleNewSession = useCallback((sessionId: string, cwd: string) => {
    invalidateWorkspaceRestore();
    const draftKey = `new:${sessionId}:${cwd}`;
    rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [invalidateWorkspaceRestore, router, isMobile]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  const handleOpenSession = useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !data.info) throw new Error(data.error ?? `HTTP ${response.status}`);
      handleSelectSession(data.info);
    } catch (error) {
      console.error("[pi-web] failed to open session:", error instanceof Error ? error.message : error);
    }
  }, [handleSelectSession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        onClick: () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
      void setupPushSubscription(locale);
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") {
          fire();
          void setupPushSubscription(locale);
        }
      });
    }
  }, [handleSelectSession, locale]);

  const handleAgentEndForSession = useCallback((targetSession: SessionInfo | null) => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (targetSession) hydrateSelectedSession(targetSession.id);

    if (targetSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });
  }, [deliverSessionNotification, hydrateSelectedSession, translate]);

  const handleAgentEnd = useCallback(() => {
    if (selectedSession?.relation?.kind === "subagent") return;
    // Historical completion tag: tag: targetSession ? `pi-session-complete:${targetSession.id}`
    handleAgentEndForSession(selectedSession);
  }, [handleAgentEndForSession, selectedSession]);

  const handleAttentionNeededForSession = useCallback((request: BlockingExtensionUiRequest, targetSession: SessionInfo | null) => {
    if (targetSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, translate]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    if (selectedSession?.relation?.kind === "subagent") return;
    // Historical gates: shouldShowBrowserNotification() and claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)
    // Historical extension tag: tag: `pi-extension-ui:${request.id}`
    handleAttentionNeededForSession(request, selectedSession);
  }, [handleAttentionNeededForSession, selectedSession]);

  const handleAutoName = useCallback(async () => {
    const targetSession = toolbarSession;
    const sessionId = targetSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    const focusToken = workspaceMode === "wall" ? wallFocus.getCurrent() : null;
    const isCurrentTarget = () => (
      activeToolbarSessionIdRef.current === sessionId
      && (workspaceMode !== "wall" || (focusToken !== null && wallFocus.accept(focusToken)))
    );
    if (workspaceMode === "wall" && focusToken === null) return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (!isCurrentTarget()) return;
      if (workspaceMode === "normal") {
        setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      }
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (!isCurrentTarget()) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, toolbarSession, wallFocus, workspaceMode]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [invalidateWorkspaceRestore, router, hydrateSelectedSession]);

  const handleAskInNewChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    sourceEntryId: string,
  ) => {
    const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
      type: "fork_branch",
      entryId: sourceEntryId,
    });
    if (!result?.newSessionId) throw new Error(translate("chat.quoteForkFailed"));
    setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
    handleSessionForked(result.newSessionId);
  }, [handleSessionForked, translate]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    invalidateWorkspaceRestore();
    sessionScrollPositionsRef.current.delete(sessionId);
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      const draftId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setNewSessionDraftId(draftId);
      activeNewSessionDraftKeyRef.current = cwd ? `new:${draftId}:${cwd}` : null;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [invalidateWorkspaceRestore, selectedSession, router]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    const existingTab = fileTabs.find((tab) => tab.id === tabId);
    const sourceTab = sourceSessionId
      ? fileTabs.find((tab) => tab.id === activeFileTabId && tab.sourceSessionId === sourceSessionId)
      : undefined;
    const sourceUsesExistingTabCwd = Boolean(
      sourceSessionId && existingTab?.sourceSessionId === sourceSessionId,
    );
    const sourceCwd = sourceSessionId
      ? sessionById.get(sourceSessionId)?.cwd
        ?? (sourceUsesExistingTabCwd ? fileTabCwds[tabId] : undefined)
        ?? (sourceTab ? fileTabCwds[sourceTab.id] : undefined)
      : undefined;
    if (sourceSessionId) {
      setFileTabCwds((previous) => {
        if (sourceCwd) {
          return previous[tabId] === sourceCwd
            ? previous
            : { ...previous, [tabId]: sourceCwd };
        }
        if (sourceUsesExistingTabCwd || !(tabId in previous)) return previous;
        const next = { ...previous };
        delete next[tabId];
        return next;
      });
    }
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      modeHint,
      sourceSessionId,
      tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, sessionById, activeFileTabId, fileTabCwds, fileTabs]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd && !tab.closing);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [terminalTabs, isMobile]);

  const handleTerminalClosed = (tab: TerminalTab) => {
    setTerminalTabs((tabs) => {
      const replacement = tab.closing === "restart" && !tabs.some((t) => t.id !== tab.id && t.cwd === tab.cwd && !t.closing) ? newTerminalTab(tab.cwd) : null;
      return tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []);
    });
    setActiveFileTabId((current) => current !== tab.id ? current : null);
  };

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && terminalTabs.length === 0) setRightPanelOpen(false);
      return next;
    });
    setFileTabCwds((previous) => {
      if (!(tabId in previous)) return previous;
      const next = { ...previous };
      delete next[tabId];
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : terminalTabs.at(-1)?.id ?? null;
    });
  }, [fileTabs, terminalTabs]);

  const handleViewFullHistory = useCallback(() => {
    if (!toolbarSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(toolbarSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [toolbarSession]);

  useEffect(() => {
    if (workspaceMode !== "normal") return;
    const target = normalSessionToRestoreRef.current;
    if (!target) return;
    normalSessionToRestoreRef.current = null;
    if (selectedSession?.id !== target.id) handleSelectSession(target);
  }, [handleSelectSession, selectedSession?.id, workspaceMode]);

  const openSessionWallPicker = useCallback((mode: "add" | "replace", paneId: string | null = null) => {
    sessionWallPickerViewRef.current += 1;
    sessionWallPickerOpenRef.current = true;
    sessionWallPickerRefreshBindingRef.current = null;
    sessionWallPickerRefreshAwaitingViewRef.current = null;
    setSessionWallRefreshState({ generation: 0, pending: false, done: false, error: null });
    setSessionWallPickerMode(mode);
    setSessionWallPickerPaneId(paneId);
    setSessionWallPickerOpen(true);
  }, []);

  const closeSessionWallPicker = useCallback(() => {
    sessionWallPickerOpenRef.current = false;
    sessionWallPickerViewRef.current += 1;
    sessionWallPickerRefreshBindingRef.current = null;
    sessionWallPickerRefreshAwaitingViewRef.current = null;
    setSessionWallRefreshState({ generation: 0, pending: false, done: false, error: null });
    setSessionWallPickerOpen(false);
  }, []);

  const handleSessionWallRefreshState = useCallback((state: SessionCatalogRefreshState) => {
    if (!sessionWallPickerOpenRef.current) return;
    const view = sessionWallPickerViewRef.current;
    const binding = sessionWallPickerRefreshBindingRef.current;
    if (!binding) {
      if (sessionWallPickerRefreshAwaitingViewRef.current !== view) return;
      sessionWallPickerRefreshBindingRef.current = { view, generation: state.generation };
    }
    const current = sessionWallPickerRefreshBindingRef.current;
    if (!current || current.view !== view || current.generation !== state.generation) return;
    setSessionWallRefreshState(state);
  }, []);

  const handleWallAddSession = useCallback((session: SessionInfo) => {
    dispatchSessionWallAction({ type: "add", sessionId: session.id });
    closeSessionWallPicker();
  }, [closeSessionWallPicker, dispatchSessionWallAction]);

  const handleWallReplaceSession = useCallback((paneId: string, session: SessionInfo) => {
    const target = activeSessionWall?.panes.find((pane) => pane.paneId === paneId);
    if (target?.paneId === focusedWallPane?.paneId) {
      clearWallToolbarState();
    }
    dispatchSessionWallAction({ type: "replace", paneId, sessionId: session.id });
    closeSessionWallPicker();
  }, [activeSessionWall, clearWallToolbarState, closeSessionWallPicker, dispatchSessionWallAction, focusedWallPane?.paneId]);

  const handleWallRemovePane = useCallback((pane: SessionWallPaneConfig) => {
    if (pane.paneId === focusedWallPane?.paneId) {
      clearWallToolbarState();
    }
    dispatchSessionWallAction({ type: "remove", paneId: pane.paneId });
    closeSessionWallPicker();
  }, [clearWallToolbarState, closeSessionWallPicker, dispatchSessionWallAction, focusedWallPane?.paneId]);

  const handleWallReplacePane = useCallback((pane: SessionWallPaneConfig) => {
    openSessionWallPicker("replace", pane.paneId);
  }, [openSessionWallPicker]);

  const handleWallSelectEmptyPane = useCallback((paneId: string) => {
    openSessionWallPicker("replace", paneId);
  }, [openSessionWallPicker]);

  const handleWallOpenManagement = useCallback(() => {
    openSessionWallPicker("add");
  }, [openSessionWallPicker]);

  const handleWallRefresh = useCallback(() => {
    if (!sessionWallPickerOpenRef.current) return;
    sessionWallPickerRefreshAwaitingViewRef.current = sessionWallPickerViewRef.current;
    setSessionWallRefreshKey((key) => key + 1);
  }, []);

  const handleWallRetryPane = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const handleWallExpandPane = useCallback((pane: SessionWallPaneConfig) => {
    const session = pane.sessionId ? sessionById.get(pane.sessionId) : null;
    if (!session) return;
    handleWallFocus(pane);
    normalSessionToRestoreRef.current = session;
    handleWorkspaceModeChange("normal");
  }, [handleWallFocus, handleWorkspaceModeChange, sessionById]);

  const handleWallOpenFile = useCallback((session: SessionInfo, filePath: string) => {
    normalSessionToRestoreRef.current = session;
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: session.id });
    handleWorkspaceModeChange("normal");
    setRightPanelOpen(true);
  }, [handleOpenFile, handleWorkspaceModeChange]);

  const handleWallSessionForked = useCallback((pane: SessionWallPaneConfig, newSessionId: string) => {
    const updatedAt = new Date().toISOString();
    updateActiveSessionWall((wall) => {
      const currentPane = wall.panes.find((candidate) => candidate.paneId === pane.paneId);
      if (
        !currentPane
        || currentPane.sessionId !== pane.sessionId
        || (currentPane.runtimeRevision ?? 0) !== (pane.runtimeRevision ?? 0)
      ) return wall;
      return sessionWallReducer(wall, {
        type: "replace",
        paneId: pane.paneId,
        sessionId: newSessionId,
        updatedAt,
      });
    });
    setRefreshKey((key) => key + 1);
  }, [updateActiveSessionWall]);
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const toolbarHasChat = workspaceMode === "wall" ? Boolean(focusedWallSession) : showChat;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // Async close completions can leave a stale active id behind; derive the
  // effective tab from the live lists so a removed tab is never selected.
  const effectiveActiveTabId = activeFileTabId !== null
    && (fileTabs.some((tab) => tab.id === activeFileTabId) || terminalTabs.some((tab) => tab.id === activeFileTabId))
    ? activeFileTabId
    : terminalTabs.at(-1)?.id ?? fileTabs.at(-1)?.id ?? null;
  const activeFileViewerCwd = activeFileTab?.sourceSessionId
    ? fileTabCwds[activeFileTab.id] ?? sessionById.get(activeFileTab.sourceSessionId)?.cwd
    : activeCwd;
  const panelsVisible = workspaceMode === "normal";
  const sidebarVisible = panelsVisible && sidebarOpen;
  const rightPanelVisible = panelsVisible && rightPanelOpen;
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  let windowTitle = "Pi Web";
  if (workspaceMode === "wall") {
    windowTitle = "Sausage Session Terminal · Pi Web";
  } else if (activeCwdName) {
    windowTitle = `${activeCwdName} - Pi Web`;
  }

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const getSessionWallPaneMetadata = useCallback((pane: SessionWallPaneConfig) => {
    const session = pane.sessionId ? sessionById.get(pane.sessionId) : null;
    if (!session) return pane.sessionId ? { name: pane.sessionId } : undefined;
    return {
      name: session.name?.trim() || session.firstMessage?.trim() || session.id,
      project: session.projectRoot ?? session.cwd,
      branch: session.branch,
      cwd: session.cwd,
      updatedLabel: session.modified,
      running: runningSessionIds.has(session.id),
    };
  }, [runningSessionIds, sessionById]);

  const getSessionWallPaneState = useCallback((pane: SessionWallPaneConfig) => {
    if (!pane.sessionId) return undefined;
    if (!sessionCatalogReady && !sessionById.has(pane.sessionId)) return { status: "loading" as const };
    return sessionById.has(pane.sessionId)
      ? { status: "ready" as const }
      : { status: "stale" as const };
  }, [sessionCatalogReady, sessionById]);

  const renderSessionWallPane = useCallback((context: SessionWallPaneRenderContext) => {
    const session = context.pane.sessionId ? sessionById.get(context.pane.sessionId) : null;
    if (!session || context.status !== "ready") return null;

    const capturedPane = context.pane;
    const capturedWallId = activeSessionWallId;
    const capturedRuntimeKey = context.runtime.runtimeKey;
    const capturedToolbarOwnerKey = getSessionWallToolbarOwnerKey({
      paneId: capturedPane.paneId,
      sessionId: session.id,
      runtimeRevision: capturedPane.runtimeRevision ?? 0,
    });
    if (!capturedToolbarOwnerKey) return null;
    const token: SessionWallFocusToken | null = wallFocus.capture(getSessionWallFocusIdentity(context.pane));
    const acceptsToolbarReport = () => (
      context.focused
      && token !== null
      && wallFocus.accept(token)
      && wallToolbarOwnershipRef.current.accepts(capturedToolbarOwnerKey)
    );
    const acceptsPaneCallback = () => acceptsWallPaneCallback(
      capturedPane,
      capturedWallId,
      capturedRuntimeKey,
    );

    return (
      <SessionWallChatWindow
        key={context.runtime.runtimeKey}
        toolbarOwnerKey={capturedToolbarOwnerKey}
        toolbarReporterController={wallToolbarReporterController}
        displayMode="wall-pane"
        session={session}
        sessionRunning={runningSessionIds.has(session.id)}
        newSessionCwd={null}
        newSessionDraftKey={null}
        keyboardActive={acceptsToolbarReport()}
        toolbarReportingActive={acceptsToolbarReport()}
        onWallHeaderStatusChange={context.onHeaderStatusChange}
        brainStatusIdentity={{
          paneId: context.pane.paneId,
          sessionId: session.id,
          runtimeKey: context.runtime.runtimeKey,
          wallId: activeSessionWallId,
        }}
        onBrainStatusReport={handleWallBrainStatusReport}
        onBlockingAttentionChange={handleWallBlockingAttention}
        wallModeActive={workspaceMode === "wall"}
        onRequestFocus={context.onRequestFocus}
        onAgentEnd={() => {
          if (!acceptsPaneCallback()) return;
          handleAgentEndForSession(session);
        }}
        onAttentionNeeded={(request) => {
          if (!acceptsPaneCallback()) return;
          handleAttentionNeededForSession(request, session);
        }}
        onSessionForked={(newSessionId) => {
          if (!acceptsPaneCallback()) return;
          handleWallSessionForked(capturedPane, newSessionId);
        }}
        modelsRefreshKey={modelsRefreshKey}
        onBranchDataChange={(tree, activeLeafId, onLeafChange) => {
          if (acceptsToolbarReport()) handleBranchDataChange(tree, activeLeafId, onLeafChange);
        }}
        onSystemPromptChange={(prompt) => {
          if (acceptsToolbarReport()) handleSystemPromptChange(prompt);
        }}
        onSystemToolsChange={(tools) => {
          if (acceptsToolbarReport()) handleSystemToolsChange(tools);
        }}
        onSystemInfoLoaderChange={(loader) => {
          if (acceptsToolbarReport()) handleSystemInfoLoaderChange(loader);
        }}
        onSessionStatsPanelOpen={() => {
          if (acceptsToolbarReport()) openWallSessionStatsPanel();
        }}
        onOpenFile={(filePath) => {
          if (!acceptsPaneCallback()) return;
          handleWallOpenFile(session, filePath);
        }}
        onOpenSession={handleOpenSession}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
      />
    );
  }, [acceptsWallPaneCallback, activeSessionWallId, handleAgentEndForSession, handleAttentionNeededForSession, handleBranchDataChange, handleOpenSession, handleSystemInfoLoaderChange, handleSystemPromptChange, handleSystemToolsChange, handleWallBrainStatusReport, handleWallBlockingAttention, handleWallOpenFile, handleWallSessionForked, modelsRefreshKey, onSoundToggle, openWallSessionStatsPanel, playDoneSound, runningSessionIds, sessionById, soundEnabled, unlockAudio, wallFocus, wallToolbarReporterController, workspaceMode]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        ownerRefreshKey={sessionWallRefreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        onOpenTerminal={handleOpenTerminal}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionsChange={handleSessionsChange}
        onCatalogRefreshStateChange={handleSessionWallRefreshState}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = section !== "models" && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate("settings.projectRequired") : label}
              aria-label={label}
              style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 32, padding: 0, background: "none", border: "none",
                borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
                fontSize: 12, opacity: disabled ? 0.35 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
            fontSize: 12, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate("common.settings")}</span>
        </button>
      </div>
    </>
  );

  const renderThemeButton = (mobile: boolean) => (
    <button
      type="button"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        if (mobile && isNarrowMobile && workspaceMode !== "wall") setMobileToolbarMoreOpen(true);
      }}
      title={translate(themeLabelKey)}
      aria-label={translate(themeLabelKey)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      data-mobile-toolbar-action={mobile ? "theme" : undefined}
    >
      {preference === "light" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : preference === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )}
    </button>
  );

  const renderLanguageButton = (mobile: boolean) => (
    <button
      ref={languageBtnRef}
      type="button"
      onClick={() => toggleTopPanel("language", mobile)}
      title={translate("common.language")}
      aria-label={translate("common.language")}
      aria-haspopup="menu"
      aria-expanded={activeTopPanel === "language"}
      aria-pressed={activeTopPanel === "language"}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
        background: activeTopPanel === "language" ? "var(--bg-selected)" : "none",
        border: "none", borderRight: "1px solid var(--border)",
        color: activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(event) => {
        event.currentTarget.style.color = activeTopPanel === "language" ? "var(--text)" : "var(--text-muted)";
      }}
      data-mobile-toolbar-action={mobile ? "language" : undefined}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </svg>
    </button>
  );

  const renderWorkspaceModeButton = (mobile: boolean) => {
    const wallActive = workspaceMode === "wall";
    const wallUnavailable = isMobile && !wallActive;
    const label = wallActive ? translate("workspace.exitWall") : translate("workspace.enterWall");
    return (
      <button
        type="button"
        disabled={wallUnavailable}
        onClick={() => handleWorkspaceModeChange(wallActive ? "normal" : "wall")}
        title={label}
        aria-label={label}
        aria-pressed={wallActive}
        data-workspace-mode-control="true"
        data-workspace-mode-mobile-disabled={wallUnavailable ? "true" : undefined}
        data-mobile-toolbar-action={mobile ? "workspace-mode" : undefined}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          background: wallActive ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          borderTop: wallActive ? "2px solid var(--accent)" : "2px solid transparent",
          color: wallActive ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = wallActive ? "var(--accent)" : "var(--text)";
          event.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = wallActive ? "var(--accent)" : "var(--text-muted)";
          event.currentTarget.style.background = wallActive ? "var(--bg-selected)" : "none";
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
      </button>
    );
  };

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (workspaceMode === "wall" || !showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={() => {
          setProjectTrustError(null);
          setProjectTrustDialogOpen(true);
        }}
        title={translate("trust.resourcesNotLoaded")}
        aria-label={translate("trust.resourcesNotLoaded")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mobileBanner ? "flex-start" : "center",
          gap: 6,
          width: mobileBanner ? "100%" : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : "100%",
          padding: mobileBanner ? "6px 12px" : "0 12px",
          background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "#d97706",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 11,
          lineHeight: 1.35,
          textAlign: "left",
        }}
        data-mobile-trust-banner={mobileBanner ? "true" : undefined}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };

  const renderChatToolbarActions = (mobile: boolean) => {
    if (!mobile && !toolbarHasChat) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        <button
          type="button"
          onClick={() => {
            handleViewFullHistory();
            if (mobile && isNarrowMobile && workspaceMode !== "wall") setMobileToolbarMoreOpen(true);
          }}
          disabled={!toolbarSession}
          title={toolbarSession ? translate("history.full") : translate("history.unsaved")}
          aria-label={translate("history.full")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%",
            padding: mobile ? 0 : "0 12px",
            background: "none",
            border: "none",
            borderTop: "2px solid transparent",
            borderRight: "1px solid var(--border)",
            color: toolbarSession ? "var(--text-muted)" : "var(--text-dim)",
            cursor: toolbarSession ? "pointer" : "not-allowed",
            opacity: toolbarSession ? 1 : 0.45,
            flexShrink: 0,
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!toolbarSession) return;
            event.currentTarget.style.color = "var(--text)";
            event.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = toolbarSession ? "var(--text-muted)" : "var(--text-dim)";
            event.currentTarget.style.background = "none";
          }}
          data-mobile-toolbar-action={mobile ? "history" : undefined}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              color: toolbarSession ? "var(--text-muted)" : "var(--text-dim)",
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
          {!mobile && <span>{translate("history.label")}</span>}
        </button>
        {(() => {
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
          const hasMessages = Boolean(
            toolbarSession
            && ((sessionStats?.userMessages ?? 0) > 0 || (toolbarSession.messageCount ?? 0) > 0),
          );
          const disabled = !toolbarSession || toolbarSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !toolbarSession || toolbarSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile && isNarrowMobile && workspaceMode !== "wall") setMobileToolbarMoreOpen(true);
              }}
              disabled={disabled}
              title={title}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
                height: "100%", padding: mobile ? 0 : "0 12px",
                background: "none", border: "none",
                borderTop: "2px solid transparent",
                borderRight: "1px solid var(--border)",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              data-mobile-toolbar-action={mobile ? "name" : undefined}
            >
              {autoNameStatus.kind === "naming" ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 4 5 5L7 22l-5-5Z" />
                  <path d="m14 5 5 5" />
                  <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                </svg>
              )}
              {!mobile && <span>{label}</span>}
            </button>
          );
        })()}
        {hasSubagentSessions && (
          <button
            type="button"
            onClick={() => toggleToolbarTopPanel("agents", mobile)}
            title={translate("agentSwitcher.title")}
            aria-label={translate("agentSwitcher.title")}
            aria-pressed={activeTopPanel === "agents"}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
              height: "100%", padding: mobile ? 0 : "0 12px",
              background: activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "agents" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
              transition: "color 0.1s, background 0.1s",
            }}
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
            {!mobile && <span>{translate("agentSwitcher.title")}</span>}
            <span
              aria-hidden="true"
              style={{
                minWidth: 15, height: 15, padding: "0 4px", display: "grid", placeItems: "center",
                borderRadius: 7, background: "var(--bg-selected)", color: "var(--accent)",
                fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
                ...(mobile ? { position: "absolute", top: 2, right: 2, minWidth: 13, height: 13, padding: "0 3px", fontSize: 9 } : {}),
              }}
            >
              {toolbarSessionFamily!.subagents.length}
            </span>
          </button>
        )}
        {sessionHasBranches && (mobile ? (
          <button
            type="button"
            onClick={() => toggleToolbarTopPanel("branches", true)}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={activeTopPanel === "branches"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              borderTop: activeTopPanel === "branches" ? "2px solid var(--accent)" : "2px solid transparent",
              borderRight: "1px solid var(--border)",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            data-mobile-toolbar-action="branches"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: branchTree.length > 0 ? "var(--accent)" : "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        ) : (
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            inline
            containerRef={topBarRef}
            open={activeTopPanel === "branches"}
            onToggle={() => toggleToolbarTopPanel("branches")}
            hasSession={Boolean(toolbarSession)}
          />
        ))}
        <button
          ref={systemBtnRef}
          type="button"
          onClick={() => handleToolbarSystemInfoToggle("system", mobile)}
          disabled={!toolbarHasChat}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={activeTopPanel === "system"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: !toolbarHasChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
            opacity: !toolbarHasChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!toolbarHasChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "system" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
          {!mobile && <span>{translate("system.label")}</span>}
        </button>
        <button
          type="button"
          onClick={() => handleToolbarSystemInfoToggle("tools", mobile)}
          disabled={!toolbarHasChat}
          title={translate("tools.title")}
          aria-label={translate("tools.title")}
          aria-pressed={activeTopPanel === "tools"}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: mobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
            height: "100%", padding: mobile ? 0 : "0 12px",
            background: activeTopPanel === "tools" ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: activeTopPanel === "tools" ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: !toolbarHasChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)",
            opacity: !toolbarHasChat ? 0.45 : 1,
            fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (!toolbarHasChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)";
          }}
          data-mobile-toolbar-action={mobile ? "tools" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemTools?.some((tool) => tool.active) ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
          </svg>
          {!mobile && <span>{translate("tools.label")}</span>}
        </button>
        {mobile && renderThemeButton(true)}
        {mobile && renderLanguageButton(true)}
      </div>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!toolbarHasChat || (!sessionStats && !contextUsage))) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
    const formatCompact = (value: number) => value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1000
        ? `${(value / 1000).toFixed(0)}k`
        : String(value);
    const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

    let contextColor = "var(--text-muted)";
    let desktopContextText: string | null = null;
    let mobileContextText: string | null = null;
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      if (percent !== null && percent > 90) contextColor = "#ef4444";
      else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
      desktopContextText = percent !== null
        ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
        : `? / ${formatCompact(contextUsage.contextWindow)}`;
      mobileContextText = percent !== null ? `${percent.toFixed(0)}%` : null;
    }

    const tooltipParts: string[] = [];
    if (tokens) {
      tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
      tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
      tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
      tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
    }
    if (contextUsage?.contextWindow) {
      const percent = contextUsage.percent;
      tooltipParts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    const hasMobileValues = Boolean(
      (tokens && (tokens.input > 0 || tokens.output > 0))
      || costText
      || mobileContextText,
    );

    return (
      <button
        type="button"
        onClick={() => toggleToolbarTopPanel("session")}
        disabled={!toolbarHasChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        aria-hidden={covered ? true : undefined}
        className={mobile ? "mobile-session-stats" : undefined}
        data-mobile-toolbar-stats={mobile ? "true" : undefined}
        style={{
          marginLeft: mobile ? 0 : "auto",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          flex: mobile ? 1 : undefined,
          minWidth: 0,
          gap: mobile ? 7 : 10,
          paddingLeft: mobile ? 6 : 12,
          paddingRight: mobile ? 6 : 12,
          height: "100%",
          overflow: "hidden",
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          borderTop: activeTopPanel === "session" ? "2px solid var(--accent)" : "2px solid transparent",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: toolbarHasChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (toolbarHasChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {mobile ? (
          <>
            {tokens && tokens.input > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span className="mobile-session-stat-io" style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {costText && (
              <span className="mobile-session-stat-cost" style={{ color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
                {costText}
              </span>
            )}
            {mobileContextText && (
              <span style={{ color: contextColor, flexShrink: 0 }}>
                {mobileContextText}
              </span>
            )}
            {!hasMobileValues && toolbarHasChat && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}>
                {translate("session.title")}
              </span>
            )}
          </>
        ) : (
          <>
            {tokens && tokens.input > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                </svg>
                {formatCompact(tokens.input)}
              </span>
            )}
            {tokens && tokens.output > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                </svg>
                {formatCompact(tokens.output)}
              </span>
            )}
            {tokens && tokens.cacheRead > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                </svg>
                {formatCompact(tokens.cacheRead)}
              </span>
            )}
            {costText && (
              <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                {costText}
              </span>
            )}
            {desktopContextText && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor }}>
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                </svg>
                {desktopContextText}
              </span>
            )}
          </>
        )}
      </button>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    const disabled = workspaceMode === "wall" || covered;
    return (
      <button
        type="button"
        onClick={handleRightPanelToggle}
        disabled={disabled}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelVisible}
        aria-hidden={covered ? true : undefined}
        title={rightPanelVisible ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelVisible ? translate("files.hidePanel") : translate("files.showPanel")}
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !mobile && !sessionStats && !contextUsage ? "auto" : 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: rightPanelVisible ? "var(--bg-selected)" : "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: rightPanelVisible ? "var(--text)" : "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer", flexShrink: 0,
          opacity: disabled && !covered ? 0.45 : 1,
          transition: "color 0.12s, background 0.12s",
        }}
        onMouseEnter={(event) => { if (!disabled) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = rightPanelVisible ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div
      data-workspace-mode={workspaceMode}
      onKeyDownCapture={(event) => {
        if (workspaceMode !== "wall" || event.key !== "Escape") return;
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || target?.isContentEditable) return;
        event.preventDefault();
      }}
      style={{
      display: "flex",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      overflow: "hidden",
      background: "var(--bg)",
    }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarVisible ? 1 : 0,
          pointerEvents: sidebarVisible ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        aria-hidden={workspaceMode === "wall" ? true : undefined}
        inert={workspaceMode === "wall" ? true : undefined}
        className={`sidebar-container${sidebarVisible ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarVisible && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div style={{ display: "flex", alignItems: "center", position: "relative", borderBottom: "1px solid var(--border)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)" }}>
          <button
            type="button"
            onClick={handleSidebarToggle}
            disabled={workspaceMode === "wall"}
             title={sidebarVisible ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarVisible ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: workspaceMode === "wall" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: workspaceMode === "wall" ? "not-allowed" : "pointer", flexShrink: 0, transition: "color 0.12s",
              opacity: workspaceMode === "wall" ? 0.45 : 1,
            }}
            onMouseEnter={(e) => { if (workspaceMode !== "wall") e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = workspaceMode === "wall" ? "var(--text-dim)" : "var(--text-muted)"; }}
          >
            {sidebarVisible ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {workspaceMode === "wall" && !isMobile && (
            <SessionWallToolbar
              layout={activeSessionWall?.layout ?? "2x2"}
              runningCount={activeSessionWall?.panes.filter((pane) => pane.sessionId !== null && runningSessionIds.has(pane.sessionId)).length ?? 0}
              attentionCount={wallAttentionCount}
              productIdentity="Sausage Session Terminal"
              productShortIdentity="SST"
              labels={{
                layout: translate("workspace.wallLayout"),
                manage: translate("workspace.wallManage"),
                running: translate("workspace.wallRunning"),
                attention: translate("workspace.wallAttention"),
              }}
              onLayoutChange={(layout) => dispatchSessionWallAction({ type: "setLayout", layout })}
              onOpenManagement={handleWallOpenManagement}
              disabled={!sessionWallHydrated || !activeSessionWall}
              ariaLabel={translate("workspace.wall")}
            />
          )}
          {isMobile && workspaceMode !== "wall" && (
            <div
              ref={mobileToolbarRef}
              data-mobile-toolbar="true"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "stretch",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              {isNarrowMobile && (
                <button
                  type="button"
                  onClick={handleMobileToolbarMoreToggle}
                  title={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-label={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-controls="mobile-toolbar-actions"
                  aria-expanded={mobileToolbarMoreOpen}
                  data-mobile-toolbar-more="true"
                  style={{
                    position: "relative",
                    zIndex: mobileToolbarMoreOpen ? 21 : undefined,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                    background: mobileToolbarMoreOpen ? "var(--bg-selected)" : "none",
                    border: "none", borderRight: "1px solid var(--border)",
                    color: mobileToolbarMoreOpen ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                  }}
                >
                  {mobileToolbarMoreOpen ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                    </svg>
                  )}
                </button>
              )}
              {!isNarrowMobile && renderChatToolbarActions(true)}
              {renderSessionStatsButton(true)}
              {renderWorkspaceModeButton(true)}
              {renderMainFileToggle(true)}
              {isNarrowMobile && panelsVisible && mobileToolbarMoreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={translate("chat.moreControls")}
                  data-mobile-toolbar-actions="true"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setMobileToolbarMoreOpen(false);
                  }}
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: TOP_BAR_ICON_BUTTON_SIZE,
                    zIndex: 20,
                    display: "flex",
                    alignItems: "stretch",
                    background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                    boxShadow: "4px 0 18px rgba(0,0,0,0.12)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {renderChatToolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <>
              {renderThemeButton(false)}
              {renderLanguageButton(false)}
              {renderProjectTrustWarning(false)}
              {renderChatToolbarActions(false)}
              {renderSessionStatsButton(false)}
            </>
          )}
          {!isMobile && renderWorkspaceModeButton(false)}
          {!isMobile && renderMainFileToggle(false)}
          {isMobile && sessionHasBranches && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              compact
              containerRef={topBarRef}
              open={activeTopPanel === "branches"}
              onToggle={() => toggleToolbarTopPanel("branches")}
              hideInlineButton
            />
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {((panelsVisible && activeTopPanel && topPanelPos) || (workspaceMode === "wall" && toolbarHasChat && activeTopPanel && topPanelPos)) && (
            <div style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "language" && (
                <div
                  role="menu"
                  aria-label={translate("common.language")}
                  style={{
                    background: "var(--bg-panel)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      style={{
                        display: "flex", alignItems: "center",
                        width: "100%", height: 34, padding: "0 10px",
                        border: "none", borderRadius: 4,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span>{plugin.label}</span>
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "agents" && toolbarSessionFamily && toolbarSession && (
                workspaceMode !== "wall" && (
                  <AgentSessionPanel
                    rootSession={toolbarSessionFamily.root}
                    subagents={toolbarSessionFamily.subagents}
                    selectedSessionId={toolbarSession.id}
                    runningSessionIds={runningSessionIds}
                    onSelectSession={handleSelectSession}
                  />
                )
              )}
              {activeTopPanel === "agents" && toolbarSessionFamily && toolbarSession && workspaceMode === "wall" && (
                <AgentSessionPanel
                  rootSession={toolbarSessionFamily.root}
                  subagents={toolbarSessionFamily.subagents}
                  selectedSessionId={toolbarSession.id}
                  runningSessionIds={runningSessionIds}
                  onSelectSession={handleWallAgentSessionSelect}
                />
              )}
              {activeTopPanel === "system" && (
                <SystemPromptPanel
                  loading={systemInfoLoading}
                  prompt={systemPrompt}
                  translate={translate}
                />
              )}
              {activeTopPanel === "tools" && (
                <ToolDefinitionsPanel
                  loading={systemInfoLoading}
                  tools={systemTools}
                  translate={translate}
                />
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;
                    const ws = toolbarSession;
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
                    ];
                    const projectRows = [
                      ...(ws ? [{ label: translate("session.projectDir"), value: ws.projectRoot ?? ws.cwd, copyField: "projectDir" as const }] : []),
                      ...(ws?.branch ? [{ label: translate("session.gitBranch"), value: ws.branch, copyField: "gitBranch" as const }] : []),
                      ...(ws?.isWorktree ? [{ label: translate("session.gitWorktree"), value: ws.cwd, copyField: "gitWorktree" as const }] : []),
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                       // Cache hit rate = cache reads / (input + cache writes + cache reads) — the denominator covers all input-class tokens.
                       ...(sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite > 0 && sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input > 0
                         ? [[translate("session.cacheHitRate"), `${(sessionStats.tokens.cacheRead / (sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite + sessionStats.tokens.input) * 100).toFixed(1)}%`]]
                         : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                    const projectInfoSection = projectRows.length > 0 ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {projectRows.map((row) => (
                            <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null;

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20 }}>
                          {sessionInfoSection}
                          {projectInfoSection}
                        </div>
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <div
            data-session-wall-workspace="true"
            data-session-wall-placeholder="false"
            role="region"
            aria-label={translate("workspace.wall")}
            style={{
              height: "100%",
              display: workspacePreferenceHydrated && sessionWallHydrated && workspaceMode === "wall" ? "flex" : "none",
              flexDirection: "column",
              minWidth: 0,
              background: "var(--bg)",
            }}
          >
            <div ref={wallViewportRef} style={{ position: "relative", flex: 1, minHeight: 0 }}>
              {activeSessionWall && sessionWallHydrated && (
                <SessionWall
                  config={activeSessionWall}
                  viewportWidth={wallViewport.width}
                  availableHeight={wallViewport.height}
                  getPaneMetadata={getSessionWallPaneMetadata}
                  getPaneState={getSessionWallPaneState}
                  getPaneBlockingAttention={getSessionWallPaneBlockingAttention}
                  onOuterScrollTopChange={handleWallOuterScrollTopChange}
                  onOuterScrollSourceChange={handleOuterScrollSourceChange}
                  renderPane={renderSessionWallPane}
                  onFocusPane={handleWallFocus}
                  onSelectEmptyPane={handleWallSelectEmptyPane}
                  onRetryPane={handleWallRetryPane}
                  onReplacePane={handleWallReplacePane}
                  onRemovePane={handleWallRemovePane}
                  onExpandPane={handleWallExpandPane}
                  getPaneResetKey={(pane) => getSessionWallPaneRuntimeKey(pane)}
                />
              )}
              {sessionWallPickerOpen && activeSessionWall && (
                <div
                  data-session-wall-picker-overlay="true"
                  style={{
                    position: "absolute",
                    inset: 0,
                    zIndex: 100,
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    padding: 12,
                    overflow: "auto",
                    background: "color-mix(in srgb, var(--bg) 78%, transparent)",
                  }}
                >
                  <SessionWallPicker
                    sessions={sessionsWithSelection}
                    loading={!sessionCatalogReady}
                    runningSessionIds={runningSessionIds}
                    config={activeSessionWall}
                    mode={sessionWallPickerMode}
                    targetPaneId={sessionWallPickerPaneId}
                    labels={{
                      title: translate("workspace.wall"),
                      addTitle: translate("workspace.wallAddTitle"),
                      replaceTitle: translate("workspace.wallReplaceTitle"),
                      search: translate("workspace.wallSearch"),
                      refresh: translate("i18n.refresh"),
                      refreshFailed: translate("workspace.wallRefreshFailed"),
                      refreshed: translate("workspace.wallRefreshed"),
                      close: translate("i18n.close"),
                      loading: translate("workspace.wallLoading"),
                      catalogError: translate("workspace.wallCatalogError"),
                      emptyCatalog: translate("workspace.wallEmpty"),
                      noResults: translate("workspace.wallNoResults"),
                      staleSelections: translate("workspace.wallStaleSelections"),
                      stale: translate("workspace.wallStale"),
                      staleDescription: translate("workspace.wallStaleDescription"),
                      select: translate("workspace.wallSelect"),
                      replace: translate("workspace.wallReplace"),
                      remove: translate("workspace.wallRemove"),
                      selected: translate("workspace.wallSelected"),
                      running: translate("workspace.wallRunning"),
                      idle: translate("workspace.wallIdle"),
                      attention: translate("workspace.wallAttention"),
                      branch: translate("workspace.wallBranch"),
                      modified: translate("workspace.wallModified"),
                      unknownProject: translate("workspace.wallUnknownProject"),
                      collapseGroup: translate("workspace.wallCollapseGroup"),
                      expandGroup: translate("workspace.wallExpandGroup"),
                    }}
                    onClose={closeSessionWallPicker}
                    onRefresh={handleWallRefresh}
                    refreshing={sessionWallRefreshState.pending}
                    refreshDone={sessionWallRefreshState.done}
                    refreshError={sessionWallRefreshState.error}
                    onAddSession={handleWallAddSession}
                    onReplaceSession={handleWallReplaceSession}
                    onRemoveSession={(paneId) => {
                      const pane = activeSessionWall.panes.find((candidate) => candidate.paneId === paneId);
                      if (pane) handleWallRemovePane(pane);
                    }}
                    onRequestReplace={(paneId) => openSessionWallPicker("replace", paneId)}
                    style={{ margin: "0 auto" }}
                  />
                </div>
              )}
            </div>
          </div>
          <div
            data-normal-chat-controller="true"
            aria-hidden={workspaceMode === "wall" ? true : undefined}
            style={{
              display: workspacePreferenceHydrated && workspaceMode === "normal" ? "contents" : "none",
              pointerEvents: workspaceMode === "wall" ? "none" : "auto",
            }}
          >
            {workspaceMode === "normal" && (
              <>
                {workspacePreferenceHydrated ? showChat ? (
                  <ChatWindow
                key={sessionKey}
                session={selectedSession}
                searchTarget={searchTarget?.sessionId === selectedSession?.id ? searchTarget : null}
                onSearchTargetHandled={handleSearchTargetHandled}
                initialScrollPosition={selectedSession ? sessionScrollPositionsRef.current.get(selectedSession.id) ?? null : null}
                onScrollPositionChange={handleSessionScrollPositionChange}
                sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
                newSessionCwd={effectiveNewSessionCwd}
                newSessionDraftKey={newSessionDraftKey}
                onAgentEnd={handleAgentEnd}
                onAttentionNeeded={handleAttentionNeeded}
                onSessionCreated={handleSessionCreated}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onBranchDataChange={handleNormalBranchDataChange}
                onSystemPromptChange={handleNormalSystemPromptChange}
                onSystemToolsChange={handleNormalSystemToolsChange}
                onSystemInfoLoaderChange={handleNormalSystemInfoLoaderChange}
                onSessionStatsChange={handleNormalSessionStatsChange}
                onSessionStatsPanelOpen={handleNormalSessionStatsPanelOpen}
                onContextUsageChange={handleNormalContextUsageChange}
                onOpenFile={handleOpenLinkedFile}
                onOpenSession={handleOpenSession}
                onAskInNewChat={handleAskInNewChat}
                quoteSelectionEnabled={quoteSelectionEnabled}
                initialPrompt={pendingQuotePrompt?.sessionId === selectedSession?.id ? pendingQuotePrompt?.text : undefined}
                onInitialPromptConsumed={() => setPendingQuotePrompt(null)}
                soundEnabled={soundEnabled}
                onSoundToggle={onSoundToggle}
                playDoneSound={playDoneSound}
                unlockAudio={unlockAudio}
              />
            ) : initialCwdStatus === "validating" ? (
              <div
                role="status"
                style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
              >
                 <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  {initialNavigation.requestedCwd}
                </div>
              </div>
            ) : initialCwdStatus === "error" ? (
              <div
                role="alert"
                style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
              >
                 <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  {initialNavigation.requestedCwd}
                </div>
                <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
              </div>
            ) : showPlaceholder ? (
              activeCwd ? (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                   {translate("workspace.selectSession")}
                </div>
              ) : (
                <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                    <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                  </svg>
                  <div>
                     <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                       <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                       <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                    </div>
                  </div>
                </div>
              )
                ) : null : null}
              </>
            )}
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelVisible ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelVisible && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        aria-hidden={workspaceMode === "wall" ? true : undefined}
        inert={workspaceMode === "wall" ? true : undefined}
        className={`right-panel-container${rightPanelVisible ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs}
              activeTabId={effectiveActiveTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>
          <button
            type="button"
            onClick={() => setRightPanelOpen(false)}
            aria-controls="file-panel"
            aria-expanded={rightPanelVisible}
            title={translate("files.hidePanel")}
            aria-label={translate("files.hidePanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "var(--bg-selected)", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeFileViewerCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialState={activeFileTab.viewerState}
              watchEnabled={rightPanelOpen}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId },
              )}
            />
          ) : !terminalTabs.some((tab) => tab.id === effectiveActiveTabId) ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          ) : null}
          {terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== effectiveActiveTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                active={rightPanelOpen && tab.id === effectiveActiveTabId}
                onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                onClosed={() => handleTerminalClosed(tab)}
                onCloseError={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: undefined } : item))}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={() => setSessionKey((key) => key + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    </>
  );
}
