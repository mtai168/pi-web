import { readFileSync, statSync } from "fs";
import type { AgentEventLike } from "./agent-event-wire";
import {
  buildSessionContext,
  invalidateSessionListCache,
  sessionEntryToUiMessage,
  type BuildSessionContextOptions,
} from "./session-reader";
import { computeSessionStats, type SessionFileStats } from "./session-stats";
import { computeSessionTotalActiveMs } from "./session-timing";
import { projectTreeForResponse } from "./project-tree";
import { readSessionToolSelection } from "./session-tool-selection";
import type { AgentMessage, SessionContext, SessionEntry, SessionTreeNode } from "./types";

// ============================================================================
// Read-only session observer
//
// Watches a persisted session JSONL and emits client-compatible agent events
// WITHOUT constructing an AgentSession. Used when mutation authority cannot be
// proven (session controlled by another Pi Web process, or ownership
// unverifiable): the wall pane keeps observing appended messages, brain
// status, and name changes while the session stays read-only here.
//
// The observer never writes the JSONL. It polls the file, applies only
// forward progress (strict appends), and re-snapshots after a full rewrite
// (compaction/migration) once the file is stable, so concurrent or reordered
// notifications can never regress transcript/leaf state to an older snapshot.
// ============================================================================

export const SESSION_OBSERVER_POLL_MS = 1_000;
export const SESSION_OBSERVER_STABILITY_MS = 200;
export const SESSION_OBSERVER_QUIET_MS = 3_000;
export const SESSION_OBSERVER_RUNNING_WINDOW_MS = 10_000;
/** Every N polls, read the file even when the stat looks unchanged. */
export const SESSION_OBSERVER_FORCE_READ_POLLS = 30;
/**
 * Stability re-checks on permanently malformed/cyclic content back off and
 * stop after this many failed attempts; the normal poll (and its periodic
 * forced read) then bounds repair detection instead of a tight read loop.
 */
export const SESSION_OBSERVER_STABILITY_MAX_RETRIES = 5;
export const SESSION_OBSERVER_STABILITY_BACKOFF_CAP_MS = 1_600;

export interface SessionObserverSnapshot {
  sessionId: string;
  filePath: string;
  leafId: string | null;
  tree: SessionTreeNode[];
  context: SessionContext;
  stats: SessionFileStats | null;
  totalActiveMs: number;
  toolNames?: string[];
  name?: string;
  /** True on evidence of activity; undefined when unknown (never a stale-mtime idle claim). */
  running: boolean | undefined;
}

export interface SessionObserverDeps {
  readFile(filePath: string): string;
  stat(filePath: string): { size: number; mtimeMs: number } | null;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  now(): number;
  buildSnapshot(
    filePath: string,
    content: string,
    sessionId: string,
    now: number,
  ): SessionObserverSnapshot;
  entryToMessage(entry: SessionEntry): AgentMessage | null;
  invalidateSessionListCache(): void;
}

function parseEntries(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (line === "") continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // A torn line is skipped; the stability/append logic re-reads it.
    }
  }
  return entries;
}

/**
 * True when every non-empty line of the tail parses as a session entry.
 */
function tailParsesCleanly(tail: string): boolean {
  for (const line of tail.split("\n")) {
    if (line === "") continue;
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * True when no entry's parent chain loops back on itself. The SDK's context
 * walkers hang on cyclic parent ids, so a cyclic file must never reach
 * buildSessionContext. Entries whose parent lives outside `entries` (applied
 * state for a tail, or a dangling reference for a full file) are acyclic by
 * construction: the applied state was already validated.
 */
function hasParentCycle(entries: SessionEntry[]): boolean {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const proven = new Set<string>();
  for (const entry of entries) {
    if (proven.has(entry.id)) continue;
    const seen = new Set<string>();
    let current: SessionEntry | undefined = entry;
    while (current) {
      if (proven.has(current.id)) break;
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      if (current.parentId === null || current.parentId === undefined) break;
      current = byId.get(current.parentId);
    }
    for (const id of seen) proven.add(id);
  }
  return false;
}

/**
 * True when the tail closes a parent cycle across the applied/tail boundary.
 * The applied graph is acyclic (validated when applied), so a cycle can only
 * involve applied entries whose parent was dangling and is now satisfied by a
 * tail entry, plus the tail entries themselves. O(tail + frontier) per append
 * instead of re-parsing the whole file.
 */
function tailClosesParentCycle(
  entries: SessionEntry[],
  appliedParents: ReadonlyMap<string, string | null>,
): boolean {
  const tailParents = new Map(entries.map((entry) => [entry.id, entry.parentId ?? null]));
  const nodes = new Set<string>(tailParents.keys());
  for (const [id, parentId] of appliedParents) {
    if (parentId !== null && tailParents.has(parentId)) nodes.add(id);
  }
  const parentOf = (id: string): string | null => {
    const tailParent = tailParents.get(id);
    if (tailParent !== undefined) return tailParent;
    return appliedParents.get(id) ?? null;
  };
  const proven = new Set<string>();
  for (const id of nodes) {
    if (proven.has(id)) continue;
    const seen = new Set<string>();
    let current: string | null = id;
    while (current !== null) {
      if (proven.has(current)) break;
      if (seen.has(current)) return true;
      seen.add(current);
      if (!nodes.has(current)) break;
      current = parentOf(current);
    }
    for (const seenId of seen) proven.add(seenId);
  }
  return false;
}

/**
 * Light structural validation for appended entries: string ids, string-or-
 * null parent ids, no self-references, no duplicate ids (within the tail or
 * against the already-applied state), and no cyclic parent chains. A tail
 * that fails validation is not applied incrementally; the observer
 * re-snapshots instead.
 */
function tailEntriesAreWellFormed(entries: SessionEntry[], knownIds: ReadonlySet<string>): boolean {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id === "") return false;
    if (entry.parentId !== undefined && entry.parentId !== null && typeof entry.parentId !== "string") return false;
    if (entry.parentId === entry.id) return false;
    if (ids.has(entry.id) || knownIds.has(entry.id)) return false;
    ids.add(entry.id);
  }
  return !hasParentCycle(entries);
}

/**
 * Structural validation for a full snapshot: unique string ids, no
 * self-referential parent ids, no cyclic parent chains. A corrupt file must
 * never become the authoritative transcript (the SDK's context walkers loop
 * on self-loops).
 */
function contentIsWellFormed(content: string): boolean {
  const entries = parseEntries(content);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id === "") return false;
    if (entry.parentId !== undefined && entry.parentId !== null && typeof entry.parentId !== "string") return false;
    if (entry.parentId === entry.id) return false;
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
  }
  return !hasParentCycle(entries);
}

function buildSessionTree(entries: SessionEntry[]): SessionTreeNode[] {
  const labelsById = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labelsById.set(entry.targetId, entry.label);
    else labelsById.delete(entry.targetId);
  }

  const nodeMap = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    // The raw file includes the session header; the SDK's getEntries()
    // filters it out of the tree.
    if ((entry as { type: string }).type === "session") continue;
    nodeMap.set(entry.id, {
      entry,
      children: [],
      ...(labelsById.has(entry.id) ? { label: labelsById.get(entry.id) } : {}),
    });
  }
  for (const entry of entries) {
    if ((entry as { type: string }).type === "session") continue;
    const node = nodeMap.get(entry.id);
    if (!node) continue;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    node.children.sort(
      (a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime(),
    );
    stack.push(...node.children);
  }
  return roots;
}

function getSessionName(entries: SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "session_info") {
      return entry.name?.trim() || undefined;
    }
  }
  return undefined;
}

export function buildSessionObserverSnapshot(
  filePath: string,
  content: string,
  sessionId: string,
  now: number,
): SessionObserverSnapshot {
  const entries = parseEntries(content);
  const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
  const contextOptions: BuildSessionContextOptions = {
    deferThinking: true,
    deferToolResultImages: true,
    tail: 50,
    sessionId,
  };
  const context = buildSessionContext(entries, leafId, contextOptions);
  const stats = computeSessionStats(entries);
  const toolNames = readSessionToolSelection(entries);
  const name = getSessionName(entries);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // File vanished between read and stat; treat as not running.
  }
  return {
    sessionId,
    filePath,
    leafId,
    tree: projectTreeForResponse(buildSessionTree(entries)),
    context,
    stats,
    totalActiveMs: computeSessionTotalActiveMs(entries),
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(name !== undefined ? { name } : {}),
    // A fresh mtime is evidence of recent activity; a stale mtime is not
    // evidence of idle, so it never claims running: false.
    running: now - mtimeMs < SESSION_OBSERVER_RUNNING_WINDOW_MS ? true : undefined,
  };
}

export interface SessionObserverLike {
  readonly mode: "observer";
  readonly isStreaming: boolean;
  readonly streamingMessage: undefined;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
}

export class SessionObserver implements SessionObserverLike {
  readonly mode = "observer" as const;
  private listener: ((event: AgentEventLike) => void) | null = null;
  private started = false;
  private stopped = false;
  private pollTimer: unknown = null;
  private quietTimer: unknown = null;
  private stabilityTimer: unknown = null;
  private pendingRewriteContent: string | null = null;
  private prevRaw = "";
  private lastStat: { size: number; mtimeMs: number } | null = null;
  private pollCount = 0;
  private stabilityRetries = 0;
  private rejectedContent: string | null = null;
  private knownIds = new Set<string>();
  private appliedParents = new Map<string, string | null>();
  private lastAppliedLeafId: string | null = null;
  private running = false;

  constructor(
    private readonly sessionId: string,
    private readonly filePath: string,
    private readonly deps: SessionObserverDeps,
  ) {}

  get isStreaming(): boolean {
    return this.running;
  }

  get streamingMessage(): undefined {
    return undefined;
  }

  onEvent(listener: (event: AgentEventLike) => void): () => void {
    if (this.started) throw new Error("SessionObserver supports a single subscriber");
    this.started = true;
    this.listener = listener;
    this.applySnapshot();
    this.pollTimer = this.deps.setTimer(() => this.poll(), SESSION_OBSERVER_POLL_MS);
    return () => this.stop();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.deps.clearTimer(this.pollTimer);
    this.deps.clearTimer(this.quietTimer);
    this.deps.clearTimer(this.stabilityTimer);
    this.listener = null;
  }

  private emit(event: AgentEventLike): void {
    if (this.stopped || !this.listener) return;
    try {
      this.listener({ ...event, sessionId: this.sessionId });
    } catch (error) {
      console.error(
        `[pi-web] failed to deliver observer event for ${this.sessionId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private clearQuietTimer(): void {
    if (this.quietTimer !== null) this.deps.clearTimer(this.quietTimer);
    this.quietTimer = null;
  }

  private markActivity(): void {
    if (!this.running) {
      this.running = true;
      this.emit({ type: "agent_start" });
    }
    this.clearQuietTimer();
    this.quietTimer = this.deps.setTimer(() => {
      this.quietTimer = null;
      if (!this.running) return;
      this.running = false;
      this.emit({ type: "agent_settled" });
    }, SESSION_OBSERVER_QUIET_MS);
  }

  private applySnapshot(): void {
    let content: string;
    try {
      content = this.deps.readFile(this.filePath);
    } catch {
      // File not created yet (or temporarily unreadable); keep polling.
      return;
    }
    if (content === this.prevRaw) return;
    // A full snapshot must be built from a cleanly parsed, structurally
    // valid file: a torn or corrupt read must not become the authoritative
    // transcript.
    if (!tailParsesCleanly(content) || !contentIsWellFormed(content)) return;
    let snapshot: SessionObserverSnapshot;
    try {
      snapshot = this.deps.buildSnapshot(this.filePath, content, this.sessionId, this.deps.now());
    } catch {
      // Torn or malformed file; keep the previous state and retry next poll.
      return;
    }
    this.prevRaw = content;
    const appliedEntries = parseEntries(content);
    this.knownIds = new Set(appliedEntries.map((entry) => entry.id));
    this.appliedParents = new Map(appliedEntries.map((entry) => [entry.id, entry.parentId ?? null]));
    this.lastAppliedLeafId = snapshot.leafId;
    const stat = this.deps.stat(this.filePath);
    if (stat) this.lastStat = stat;
    // Fresh mtime is evidence of recent activity; a stale mtime is not
    // evidence of idle, so the snapshot carries no idle claim.
    if (snapshot.running === true) {
      this.running = true;
      this.clearQuietTimer();
      this.quietTimer = this.deps.setTimer(() => {
        this.quietTimer = null;
        if (!this.running) return;
        this.running = false;
        this.emit({ type: "agent_settled" });
      }, SESSION_OBSERVER_QUIET_MS);
    }
    this.emit({
      type: "session_snapshot",
      sessionId: this.sessionId,
      snapshot: {
        ...snapshot,
        running: this.running || snapshot.running === true ? true : undefined,
      },
    });
  }

  private emitEntryEvents(entry: SessionEntry, content: string): void {
    switch (entry.type) {
      case "message":
      case "branch_summary":
      case "custom_message": {
        const message = this.deps.entryToMessage(entry);
        if (message) {
          this.markActivity();
          this.emit({ type: "message_end", message, entryId: entry.id });
        }
        break;
      }
      case "compaction":
        this.markActivity();
        this.emit({ type: "compaction_start" });
        this.emit({
          type: "compaction_end",
          ...(typeof entry.tokensBefore === "number" ? { tokensBefore: entry.tokensBefore } : {}),
        });
        break;
      case "session_info":
        this.deps.invalidateSessionListCache();
        this.emit({ type: "session_info", name: entry.name });
        // Renames also refresh the authoritative snapshot so the viewer's
        // name/thinking metadata does not go stale until reconnect.
        this.emitMetadataSnapshot(content);
        break;
      case "label":
      case "model_change":
      case "thinking_level_change":
        // State-affecting metadata: refresh the authoritative snapshot so the
        // viewer's tree/model/leaf metadata does not go stale until reconnect.
        this.emitMetadataSnapshot(content);
        break;
      default:
        break;
    }
  }

  private emitMetadataSnapshot(content: string): void {
    let snapshot: SessionObserverSnapshot;
    try {
      snapshot = this.deps.buildSnapshot(this.filePath, content, this.sessionId, this.deps.now());
    } catch {
      return;
    }
    // The running flag reflects observed append activity, not file mtime:
    // no activity evidence means no claim at all, never a stale idle.
    this.emit({
      type: "session_snapshot",
      snapshot: { ...snapshot, running: this.running ? true : undefined },
    });
  }

  private setPendingRewrite(content: string): void {
    // New content is progress: reset the stability retry budget so a repair
    // after a malformed spell gets a fresh set of re-checks. Content the
    // budget already gave up on must not reset it on every poll.
    if (content !== this.pendingRewriteContent && content !== this.rejectedContent) {
      this.stabilityRetries = 0;
      this.rejectedContent = null;
    }
    const changed = content !== this.pendingRewriteContent;
    this.pendingRewriteContent = content;
    if (changed && this.stabilityTimer !== null) {
      // The pending content changed while a stability check was scheduled:
      // the old timer's deadline belongs to the previous content. Cancel it
      // and start a fresh quiet period from this change, so a partially
      // written rewrite can never become authoritative after only the
      // remaining old delay.
      this.deps.clearTimer(this.stabilityTimer);
      this.stabilityTimer = null;
      this.scheduleStabilityCheck();
    }
  }

  private scheduleStabilityCheck(): void {
    if (this.stopped) return;
    // A pending re-check already covers the current content: the poll must
    // not displace it, or a backed-off check could be deferred forever.
    if (this.stabilityTimer !== null) return;
    if (this.stabilityRetries >= SESSION_OBSERVER_STABILITY_MAX_RETRIES) {
      // Permanently malformed/cyclic content: stop the stability re-check
      // loop and return to the normal poll. The periodic forced read still
      // detects a same-stat repair within a bounded interval, and any
      // content change resets the budget via setPendingRewrite.
      this.rejectedContent = this.pendingRewriteContent;
      this.pendingRewriteContent = null;
      this.stabilityTimer = null;
      return;
    }
    const delay = Math.min(
      SESSION_OBSERVER_STABILITY_MS * 2 ** this.stabilityRetries,
      SESSION_OBSERVER_STABILITY_BACKOFF_CAP_MS,
    );
    this.stabilityTimer = this.deps.setTimer(() => {
      this.stabilityTimer = null;
      if (this.stopped) return;
      let current: string;
      try {
        current = this.deps.readFile(this.filePath);
      } catch {
        this.pendingRewriteContent = null;
        return;
      }
      if (current !== this.pendingRewriteContent) {
        this.setPendingRewrite(current);
        this.scheduleStabilityCheck();
        return;
      }
      // Revalidate the relationship with the last applied state: a stable
      // strict prefix (including an empty truncation) means the writer
      // truncated mid-rewrite, so applying it would regress the transcript.
      // Back off and re-check; after the retry budget the normal poll (with
      // its periodic forced read) takes over, so an abandoned truncation
      // cannot force a read on every poll forever while a same-stat repair
      // stays discoverable within a bounded interval.
      if (this.prevRaw.startsWith(current) && current !== this.prevRaw) {
        this.stabilityRetries += 1;
        this.scheduleStabilityCheck();
        return;
      }
      if (current === this.prevRaw) {
        // The writer rolled the rejected tail back: nothing to apply.
        this.pendingRewriteContent = null;
        this.rejectedContent = null;
        return;
      }
      const before = this.prevRaw;
      this.applySnapshot();
      if (this.prevRaw === before) {
        // The stable content was not applied (malformed or cyclic): back off
        // and re-check; after the retry budget the normal poll takes over.
        this.stabilityRetries += 1;
        this.scheduleStabilityCheck();
        return;
      }
      this.stabilityRetries = 0;
      this.pendingRewriteContent = null;
      this.rejectedContent = null;
    }, delay);
  }

  private poll(): void {
    if (this.stopped) return;
    this.pollTimer = this.deps.setTimer(() => this.poll(), SESSION_OBSERVER_POLL_MS);
    this.pollCount += 1;

    // Fast path: skip the read when the file looks unchanged. A periodic
    // forced read bounds staleness for same-size/same-mtime rewrites; a
    // pending rewrite also forces reads so a same-stat repair is observed
    // promptly instead of at the next forced read.
    const forceRead = this.pollCount % SESSION_OBSERVER_FORCE_READ_POLLS === 0;
    const stat = this.deps.stat(this.filePath);
    // An empty-string rewrite is still a pending rewrite: only the explicit
    // null sentinel means no pending content, so a pending empty file keeps
    // forcing reads until the rewrite completes or is repaired.
    if (!forceRead && this.pendingRewriteContent === null && stat && this.lastStat && stat.size === this.lastStat.size && stat.mtimeMs === this.lastStat.mtimeMs) {
      return;
    }

    let content: string;
    try {
      content = this.deps.readFile(this.filePath);
    } catch {
      // File missing: keep the last applied state; a reappearing file is a
      // rewrite and re-snapshots.
      return;
    }
    if (content === this.prevRaw) {
      if (stat) this.lastStat = stat;
      return;
    }

    // First appearance of a previously missing file is a full write, not an
    // append: re-snapshot so the client receives the complete transcript.
    if (this.prevRaw === "" && content !== "") {
      this.setPendingRewrite(content);
      this.scheduleStabilityCheck();
      return;
    }

    if (content.startsWith(this.prevRaw)) {
      const tail = content.slice(this.prevRaw.length);
      if (!tail.endsWith("\n")) return; // torn append; wait for completion
      // A complete-but-malformed line must not advance the applied offset:
      // keep the last applied state until the whole tail parses, so a
      // repaired line is eventually observed instead of skipped forever.
      if (!tailParsesCleanly(tail)) {
        this.setPendingRewrite(content);
        this.scheduleStabilityCheck();
        return;
      }
      const entries = parseEntries(tail);
      if (entries.length === 0) {
        this.prevRaw = content;
        if (stat) this.lastStat = stat;
        return;
      }
      if (!tailEntriesAreWellFormed(entries, this.knownIds) || tailClosesParentCycle(entries, this.appliedParents)) {
        // Structurally invalid append (including a cycle closed by a forward
        // reference into the already-applied content): do not advance the
        // incremental state; reconcile through the stable snapshot path
        // instead, and keep re-checking so a repair is observed promptly.
        this.setPendingRewrite(content);
        this.scheduleStabilityCheck();
        return;
      }
      // A strict append continues the active branch: every new entry's parent
      // is the previously applied entry. A branch switch (or any other
      // off-branch append) must never advance the leaf incrementally — the
      // client would append an off-branch message; reconcile via a full
      // snapshot instead.
      let previousId = this.lastAppliedLeafId;
      let onBranch = true;
      for (const entry of entries) {
        if (entry.parentId !== previousId) {
          onBranch = false;
          break;
        }
        previousId = entry.id;
      }
      if (!onBranch) {
        this.setPendingRewrite(content);
        this.scheduleStabilityCheck();
        return;
      }
      for (const entry of entries) this.emitEntryEvents(entry, content);
      for (const entry of entries) this.knownIds.add(entry.id);
      for (const entry of entries) this.appliedParents.set(entry.id, entry.parentId ?? null);
      this.lastAppliedLeafId = entries[entries.length - 1].id;
      this.prevRaw = content;
      if (stat) this.lastStat = stat;
      return;
    }

    // Full rewrite (compaction/migration/truncate): wait for the file to be
    // stable before re-snapshotting so a mid-write read cannot regress state.
    // A strict prefix (the file shrank to a prefix of the last applied
    // state) means the writer is mid-rewrite: keep the last applied state
    // until the rewrite completes. The stat is recorded so that once the
    // stability budget is exhausted an abandoned truncation falls back to
    // the fast path (unchanged polls skip reads until the forced read).
    if (this.prevRaw.startsWith(content)) {
      if (stat) this.lastStat = stat;
      return;
    }
    this.setPendingRewrite(content);
    this.scheduleStabilityCheck();
  }
}

export function createSessionObserver(
  sessionId: string,
  filePath: string,
  deps?: Partial<SessionObserverDeps>,
): SessionObserver {
  const entryToMessage = (entry: SessionEntry): AgentMessage | null =>
    sessionEntryToUiMessage(entry, {
      deferThinking: true,
      deferToolResultImages: true,
      sessionId,
    });
  const fullDeps: SessionObserverDeps = {
    readFile: (path) => readFileSync(path, "utf8"),
    stat: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    now: Date.now,
    buildSnapshot: buildSessionObserverSnapshot,
    entryToMessage,
    invalidateSessionListCache,
    ...deps,
  };
  return new SessionObserver(sessionId, filePath, fullDeps);
}
