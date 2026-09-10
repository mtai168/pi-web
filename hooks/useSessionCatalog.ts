"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const RUNNING_SESSIONS_POLL_MS = 2500;

export interface SessionCatalogResponse {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  completionNotificationSuppressedSessionIds: string[];
  sessionListVersion: number | null;
}

export interface SessionCatalogRefreshOptions {
  showLoading?: boolean;
  force?: boolean;
  background?: boolean;
  ownerGeneration?: number;
}

export interface SessionCatalogRefreshState {
  generation: number;
  pending: boolean;
  done: boolean;
  error: string | null;
}

export interface SessionCatalogTransitionInput {
  previousRunningSessionIds: ReadonlySet<string>;
  runningSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  previousSuppressedCompletionSessionIds: ReadonlySet<string>;
  knownSubagentIds: ReadonlySet<string>;
}

export interface SessionCatalogTransitions {
  completedInBackground: string[];
  completedWithNotifications: string[];
  newlyRunning: string[];
}

export interface UseSessionCatalogOptions {
  selectedSessionId: string | null;
  refreshKey?: number;
  ownerRefreshKey?: number;
  onBackgroundTaskDone?: () => void;
  onOwnerRefreshStateChange?: (state: SessionCatalogRefreshState) => void;
}

export interface SessionCatalog {
  sessions: SessionInfo[];
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  sessionListVersion: number | null;
  loading: boolean;
  error: string | null;
  refreshDone: boolean;
  refresh: (options?: SessionCatalogRefreshOptions) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

export function getSessionCatalogUrl(force = false): string {
  return force ? "/api/sessions?force=1" : "/api/sessions";
}

export function normalizeSessionCatalogResponse(value: unknown): SessionCatalogResponse {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error("Invalid session catalog response");
  }
  return {
    sessions: value.sessions.filter(isSessionInfo),
    runningSessionIds: normalizeStringArray(value.runningSessionIds),
    completionNotificationSuppressedSessionIds: normalizeStringArray(
      value.completionNotificationSuppressedSessionIds,
    ),
    sessionListVersion: typeof value.sessionListVersion === "number" ? value.sessionListVersion : null,
  };
}

export function normalizeRunningSessionResponse(value: unknown): Pick<
  SessionCatalogResponse,
  "runningSessionIds" | "completionNotificationSuppressedSessionIds" | "sessionListVersion"
> {
  if (!isRecord(value)) throw new Error("Invalid running session response");
  return {
    runningSessionIds: normalizeStringArray(value.runningSessionIds),
    completionNotificationSuppressedSessionIds: normalizeStringArray(
      value.completionNotificationSuppressedSessionIds,
    ),
    sessionListVersion: typeof value.sessionListVersion === "number" ? value.sessionListVersion : null,
  };
}

const SUBAGENT_STATUSES = new Set([
  "starting",
  "running",
  "completed",
  "failed",
  "aborted",
  "interrupted",
]);

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!isRecord(value)
    || typeof value.path !== "string"
    || typeof value.id !== "string"
    || typeof value.cwd !== "string"
    || typeof value.created !== "string"
    || typeof value.modified !== "string"
    || typeof value.messageCount !== "number"
    || typeof value.firstMessage !== "string"
    || !isOptionalString(value.name)
    || !isOptionalString(value.parentSessionId)
    || !isOptionalString(value.projectRoot)
    || !isOptionalString(value.projectKey)
    || !isOptionalString(value.branch)
    || (value.isWorktree !== undefined && typeof value.isWorktree !== "boolean")
    || (value.transient !== undefined && typeof value.transient !== "boolean")
  ) return false;

  if (value.relation === undefined) return true;
  if (!isRecord(value.relation) || typeof value.relation.kind !== "string") return false;
  if (value.relation.kind === "fork") {
    return isOptionalString(value.relation.originSessionId);
  }
  return value.relation.kind === "subagent"
    && typeof value.relation.parentSessionId === "string"
    && typeof value.relation.profile === "string"
    && typeof value.relation.description === "string"
    && typeof value.relation.status === "string"
    && SUBAGENT_STATUSES.has(value.relation.status);
}

export interface SessionCatalogRequest {
  id: number;
  promise: Promise<SessionCatalogResponse | null>;
}

export interface SessionCatalogRequester {
  request(force?: boolean): SessionCatalogRequest;
  isCurrent(id: number): boolean;
  isPending(): boolean;
  cancel(): void;
}

export function createSessionCatalogRequester(
  fetcher: typeof fetch = fetch,
  onPendingChange?: (pending: boolean) => void,
): SessionCatalogRequester {
  let latestRequestId = 0;
  let controller: AbortController | null = null;

  const request = (force = false): SessionCatalogRequest => {
    const id = ++latestRequestId;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    onPendingChange?.(true);
    const promise = (async () => {
      try {
        const response = await fetcher(getSessionCatalogUrl(force), {
          cache: "no-store",
          signal: current.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = normalizeSessionCatalogResponse(await response.json());
        return id === latestRequestId ? data : null;
      } catch (error) {
        if (current.signal.aborted || id !== latestRequestId) return null;
        throw error;
      } finally {
        if (controller === current) {
          controller = null;
          onPendingChange?.(false);
        }
      }
    })();
    return { id, promise };
  };

  return {
    request,
    isCurrent: (id) => id === latestRequestId,
    isPending: () => controller !== null,
    cancel: () => {
      latestRequestId++;
      if (!controller) return;
      controller.abort();
      controller = null;
      onPendingChange?.(false);
    },
  };
}

type RunningSessionSnapshot = Pick<
  SessionCatalogResponse,
  "runningSessionIds" | "completionNotificationSuppressedSessionIds" | "sessionListVersion"
>;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface RunningSessionPollerOptions {
  fetcher?: typeof fetch;
  isVisible: () => boolean;
  onSnapshot: (snapshot: RunningSessionSnapshot) => void;
  subscribeVisibility: (listener: () => void) => () => void;
  intervalMs?: number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

export interface RunningSessionPoller {
  start(): void;
  stop(): void;
}

export function createRunningSessionPoller({
  fetcher = fetch,
  isVisible,
  onSnapshot,
  subscribeVisibility,
  intervalMs = RUNNING_SESSIONS_POLL_MS,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}: RunningSessionPollerOptions): RunningSessionPoller {
  let active = false;
  let timer: TimerHandle | null = null;
  let controller: AbortController | null = null;
  let unsubscribeVisibility: (() => void) | null = null;

  const clearScheduled = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const poll = async () => {
    if (!active || !isVisible()) return;
    const current = new AbortController();
    controller?.abort();
    controller = current;
    try {
      const response = await fetcher("/api/agent/running", {
        cache: "no-store",
        signal: current.signal,
      });
      if (!response.ok) return;
      const snapshot = normalizeRunningSessionResponse(await response.json());
      if (!active || controller !== current) return;
      onSnapshot(snapshot);
    } catch {
      // Keep the last known state; the next visible-tab poll retries.
    } finally {
      if (controller !== current) return;
      controller = null;
      clearScheduled();
      if (active && isVisible()) timer = setTimer(() => void poll(), intervalMs);
    }
  };

  const onVisibilityChange = () => {
    if (isVisible()) {
      void poll();
      return;
    }
    clearScheduled();
    controller?.abort();
    controller = null;
  };

  return {
    start: () => {
      if (active) return;
      active = true;
      unsubscribeVisibility = subscribeVisibility(onVisibilityChange);
      void poll();
    },
    stop: () => {
      if (!active) return;
      active = false;
      clearScheduled();
      controller?.abort();
      controller = null;
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
    },
  };
}

export function getSessionCatalogTransitions({
  previousRunningSessionIds,
  runningSessionIds,
  selectedSessionId,
  previousSuppressedCompletionSessionIds,
  knownSubagentIds,
}: SessionCatalogTransitionInput): SessionCatalogTransitions {
  const completedInBackground = [...previousRunningSessionIds].filter(
    (id) => !runningSessionIds.has(id) && id !== selectedSessionId,
  );
  return {
    completedInBackground,
    completedWithNotifications: completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIds.has(id) && !knownSubagentIds.has(id),
    ),
    newlyRunning: [...runningSessionIds].filter((id) => !previousRunningSessionIds.has(id)),
  };
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage is best-effort.
  }
}

export function useSessionCatalog({
  selectedSessionId,
  refreshKey,
  ownerRefreshKey,
  onBackgroundTaskDone,
  onOwnerRefreshStateChange,
}: UseSessionCatalogOptions): SessionCatalog {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const [refreshDone, setRefreshDone] = useState(false);
  const [sessionListVersion, setSessionListVersion] = useState<number | null>(null);
  const sessionListVersionRef = useRef<number | null>(null);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const runningPollAuthoritativeRef = useRef(false);
  const initialLoadDoneRef = useRef(false);
  const onOwnerRefreshStateChangeRef = useRef(onOwnerRefreshStateChange);
  onOwnerRefreshStateChangeRef.current = onOwnerRefreshStateChange;
  const sessionRequesterRef = useRef<SessionCatalogRequester | null>(null);
  const backgroundRefreshPendingRef = useRef(false);
  const ownerRefreshRequestIdRef = useRef<number | null>(null);
  const ownerRefreshGenerationRef = useRef(0);
  const ownerRefreshInitializedRef = useRef(false);
  const ownerRefreshDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef<((options?: SessionCatalogRefreshOptions) => Promise<void>) | null>(null);
  const refreshDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!sessionRequesterRef.current) {
    sessionRequesterRef.current = createSessionCatalogRequester(fetch);
  }

  const refresh = useCallback(async ({
    showLoading = false,
    force = false,
    background = false,
    ownerGeneration,
  }: SessionCatalogRefreshOptions = {}) => {
    const requester = sessionRequesterRef.current!;
    if (
      ownerGeneration === undefined
      && ownerRefreshRequestIdRef.current !== null
      && requester.isPending()
    ) {
      backgroundRefreshPendingRef.current = true;
      return;
    }
    if (background && requester.isPending()) {
      backgroundRefreshPendingRef.current = true;
      return;
    }
    const request = requester.request(force);
    if (ownerGeneration !== undefined) {
      ownerRefreshRequestIdRef.current = request.id;
      if (ownerRefreshDoneTimerRef.current) clearTimeout(ownerRefreshDoneTimerRef.current);
      onOwnerRefreshStateChangeRef.current?.({ generation: ownerGeneration, pending: true, done: false, error: null });
    }
    if (showLoading) setLoading(true);

    try {
      const data = await request.promise;
      if (!data || !requester.isCurrent(request.id)) return;

      setSessions(data.sessions);
      sessionListVersionRef.current = data.sessionListVersion;
      setSessionListVersion(data.sessionListVersion);
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds,
        );
        setRunningSessionIds(new Set(data.runningSessionIds));
      }
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((previous) => {
        if (previous.size === 0) return previous;
        const next = new Set([...previous].filter((id) => unreadEligibleIds.has(id)));
        return next.size === previous.size ? previous : next;
      });
      setError(null);
      if (!showLoading) {
        setRefreshDone(true);
        if (refreshDoneTimerRef.current) clearTimeout(refreshDoneTimerRef.current);
        refreshDoneTimerRef.current = setTimeout(() => setRefreshDone(false), 2000);
      }
      if (ownerGeneration !== undefined && ownerRefreshRequestIdRef.current === request.id) {
        ownerRefreshRequestIdRef.current = null;
        onOwnerRefreshStateChangeRef.current?.({ generation: ownerGeneration, pending: false, done: true, error: null });
        ownerRefreshDoneTimerRef.current = setTimeout(() => {
          if (ownerRefreshGenerationRef.current === ownerGeneration) {
            onOwnerRefreshStateChangeRef.current?.({ generation: ownerGeneration, pending: false, done: false, error: null });
          }
        }, 2000);
      }
    } catch (requestError) {
      if (!requester.isCurrent(request.id)) return;
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      if (ownerGeneration !== undefined && ownerRefreshRequestIdRef.current === request.id) {
        ownerRefreshRequestIdRef.current = null;
        onOwnerRefreshStateChangeRef.current?.({ generation: ownerGeneration, pending: false, done: false, error: message });
      }
    } finally {
      if (requester.isCurrent(request.id)) {
        setLoading(false);
        if (backgroundRefreshPendingRef.current) {
          backgroundRefreshPendingRef.current = false;
          void refreshRef.current?.({ force: true, background: true });
        }
      }
    }
  }, []);

  refreshRef.current = refresh;

  useEffect(() => {
    const isFirst = !initialLoadDoneRef.current;
    initialLoadDoneRef.current = true;
    void refresh({ showLoading: isFirst, force: !isFirst });
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (ownerRefreshKey === undefined) return;
    if (!ownerRefreshInitializedRef.current) {
      ownerRefreshInitializedRef.current = true;
      return;
    }
    const generation = ownerRefreshGenerationRef.current + 1;
    ownerRefreshGenerationRef.current = generation;
    void refresh({ force: true, ownerGeneration: generation });
  }, [ownerRefreshKey, refresh]);

  useEffect(() => () => {
    if (ownerRefreshGenerationRef.current > 0) {
      onOwnerRefreshStateChangeRef.current?.({
        generation: ownerRefreshGenerationRef.current,
        pending: false,
        done: false,
        error: null,
      });
    }
    sessionRequesterRef.current?.cancel();
    backgroundRefreshPendingRef.current = false;
    ownerRefreshRequestIdRef.current = null;
    if (ownerRefreshDoneTimerRef.current) clearTimeout(ownerRefreshDoneTimerRef.current);
    if (refreshDoneTimerRef.current) clearTimeout(refreshDoneTimerRef.current);
  }, []);

  useEffect(() => {
    const poller = createRunningSessionPoller({
      isVisible: () => document.visibilityState === "visible",
      onSnapshot: (data) => {
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds,
        );
        setRunningSessionIds(new Set(data.runningSessionIds));
        if (data.sessionListVersion !== null && data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          void refreshRef.current?.({ background: true });
        }
      },
      subscribeVisibility: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    });
    poller.start();
    return () => poller.stop();
  }, []);

  useEffect(() => {
    const knownSubagentIds = new Set(
      sessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const transitions = getSessionCatalogTransitions({
      previousRunningSessionIds: previousRunningSessionIdsRef.current,
      runningSessionIds,
      selectedSessionId,
      previousSuppressedCompletionSessionIds: previousSuppressedCompletionSessionIdsRef.current,
      knownSubagentIds,
    });

    if (transitions.completedWithNotifications.length > 0 || transitions.newlyRunning.length > 0) {
      setUnreadSessionIds((previous) => {
        const next = new Set(previous);
        runningSessionIds.forEach((id) => next.delete(id));
        transitions.completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = transitions.newlyRunning.some(
      (id) => !sessions.some((session) => session.id === id),
    );
    if (transitions.completedInBackground.length > 0 || hasUnlistedRunningSession) {
      void refresh({ force: true, background: true });
    }
    if (transitions.completedWithNotifications.length > 0) onBackgroundTaskDone?.();

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, sessions, refresh, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((previous) => {
      if (!previous.has(selectedSessionId)) return previous;
      const next = new Set(previous);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  return {
    sessions,
    runningSessionIds,
    unreadSessionIds,
    sessionListVersion,
    loading,
    error,
    refreshDone,
    refresh,
  };
}
