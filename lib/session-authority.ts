import { randomUUID } from "crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import lockfile from "proper-lockfile";

// ============================================================================
// Session mutation authority
//
// A persisted Pi session may be mutated by exactly one Pi Web process at a
// time. Authority is the conjunction of two independent proofs:
//
//  1. External-owner proof: the configured external Pi Web process (the
//     separately installed official package, PI_WEB_EXTERNAL_OWNER_URL) does
//     not report the session as live in its own registry. Its
//     GET /api/agent/[id] is authoritative for its own process; we never
//     guess ownership from PPID, process ancestry, a stale PID, or a port.
//  2. Lease: an atomic sidecar lease file next to the session JSONL. The
//     lease carries a random owner id (never a PID), an expiry, and a
//     version. Stale (expired) leases are taken over under a proper-lockfile
//     mutex; a crashed owner is recovered purely by time, so PID reuse can
//     never confuse ownership.
//
// Failure model (see docs/adr/0004-session-mutation-authority.md):
//  - external "owned"            -> fail closed (externally_owned)
//  - external unreachable        -> fail closed (authority_unverifiable)
//  - lease held by another owner -> fail closed (lease_held)
//  - lease lost while held       -> revoke (lease_lost)
//  - external takeover while held -> revoke (externally_owned)
// ============================================================================

export type SessionAuthorityErrorCode =
  | "externally_owned"
  | "lease_held"
  | "authority_unverifiable"
  | "lease_lost"
  | "external_owner_mode";

export class SessionAuthorityError extends Error {
  constructor(
    public readonly code: SessionAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionAuthorityError";
  }
}

/**
 * instanceof is unreliable across bundler/jiti module instances; the class
 * name is the stable contract.
 */
export function isSessionAuthorityError(error: unknown): error is SessionAuthorityError {
  return error instanceof SessionAuthorityError
    || (error instanceof Error && error.name === "SessionAuthorityError");
}

export function authorityErrorMessage(error: SessionAuthorityError): string {
  switch (error.code) {
    case "externally_owned":
      return "This session is controlled by another Pi Web process and is read-only here.";
    case "lease_held":
      return "This session is being used by another Pi Web process and is read-only here.";
    case "authority_unverifiable":
      return "Session ownership cannot be verified (external Pi Web unreachable); the session is read-only here.";
    case "lease_lost":
      return "Mutation authority for this session was lost; the session is read-only here.";
    case "external_owner_mode":
      return "This Pi Web instance is configured with an external owner; sessions are controlled by the configured Pi Web process.";
  }
}

/**
 * A synchronous appender call failed after earlier operations in the same
 * sequence were already applied. The SDK offers no rollback, so the caller
 * must not retry the sequence (entries would duplicate). appliedCount
 * reports the operations whose appender call returned, for diagnostics; the
 * failing operation's own commit state is unknown (the appender may have
 * written before throwing), so appliedCount is never a retry signal.
 */
export class SessionAppendError extends Error {
  constructor(
    public readonly appliedCount: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SessionAppendError";
  }
}

export function isSessionAppendError(error: unknown): error is SessionAppendError {
  if (error instanceof SessionAppendError) return true;
  if (!(error instanceof Error) || error.name !== "SessionAppendError") return false;
  // instanceof is unreliable across bundler/jiti module instances; the class
  // name plus the appliedCount shape is the stable contract.
  const appliedCount = (error as SessionAppendError).appliedCount;
  return typeof appliedCount === "number" && Number.isInteger(appliedCount) && appliedCount >= 0;
}

export interface SessionLease {
  ownerId: string;
  sessionId: string;
  sessionFile: string;
  acquiredAt: number;
  expiresAt: number;
  version: number;
  /** Unique per acquisition; release/revoke only remove a lease they own. */
  token: string;
}

/**
 * Minimal structural appender bound to the authority at acquisition time:
 * the only session mutations the authority executes. The authority invokes
 * these methods itself, synchronously, while the lease mutex is provably
 * held. No caller-supplied executable callback, promise, thenable, thunk,
 * or function may cross the authority boundary per call. A thenable or
 * non-string result fails immediately; asynchronous appenders are
 * unsupported.
 */
export interface SessionAppender {
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
}

/**
 * Closed discriminated union of the synchronous session appends the
 * authority executes. Unknown kinds are rejected before any append runs.
 */
export type SessionAppendOperation =
  | { kind: "custom_entry"; customType: string; data?: unknown }
  | { kind: "session_info"; name: string };

function validateAppendOperations(operations: SessionAppendOperation[]): void {
  for (const operation of operations) {
    if (operation.kind === "custom_entry") {
      if (typeof operation.customType !== "string" || operation.customType === "") {
        throw new TypeError("appendSessionEntries: custom_entry requires a non-empty customType");
      }
    } else if (operation.kind === "session_info") {
      if (typeof operation.name !== "string") {
        throw new TypeError("appendSessionEntries: session_info requires a name string");
      }
    } else {
      throw new TypeError("appendSessionEntries: unknown operation kind");
    }
  }
}

export type ExternalOwnership = "owned" | "free" | "unreachable";

export interface ExternalOwnerClient {
  /** True when an external Pi Web process is configured at all. */
  isConfigured(): boolean;
  /** Authoritative check against the external process's own registry. */
  check(sessionId: string, options?: { fresh?: boolean }): Promise<ExternalOwnership>;
}

export interface SessionAuthorityDeps {
  now(): number;
  externalOwnership(
    sessionId: string,
    options?: { fresh?: boolean },
  ): Promise<ExternalOwnership>;
  readLease(leasePath: string): SessionLease | null;
  /** Atomic no-clobber create; throws EEXIST when the lease already exists. */
  createLease(leasePath: string, lease: SessionLease): void;
  /** Atomic replace of an expired lease; caller holds the lease mutex. */
  replaceLease(leasePath: string, lease: SessionLease): void;
  removeLease(leasePath: string): void;
  /** Serializes takeover/renewal/release of one lease path. */
  lockLease(leasePath: string): Promise<() => void>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface AuthorityHandle {
  readonly sessionId: string;
  isHeld(): boolean;
  /** Release the lease and stop renewal/re-check timers. Idempotent. */
  release(): void;
  /** Fired once when authority is lost (external takeover, unreachable, or
   *  lease takeover). The holder must stop mutating immediately. */
  onRevoked(callback: () => void): void;
}

/**
 * Authority handle with a synchronous SessionAppender bound at acquisition
 * time. Exposes appendSessionEntries(operations) only: no appender,
 * callback, function, thunk, promise, or thenable is accepted per call.
 */
export interface AppenderAuthorityHandle extends AuthorityHandle {
  /**
   * Append a closed sequence of session entries while the lease is provably
   * held. The same per-lease mutex used for ownership changes is held for
   * the whole sequence; the lease is re-read and verified (exact
   * owner/token/version, not expired) and renewed before every operation.
   * The bound appender's methods are executed synchronously while the mutex
   * is held; a thenable or non-string result fails immediately. Throws
   * SessionAuthorityError("lease_lost") when the lease is released, revoked,
   * expired, foreign, or missing; throws SessionAppendError carrying
   * appliedCount when a later appender call fails after earlier operations
   * were applied (the SDK offers no rollback, so the caller must not retry
   * the sequence). Invalid operations reject before any append runs.
   * Returns the appended entry ids in order.
   */
  appendSessionEntries(operations: SessionAppendOperation[]): Promise<string[]>;
}

export interface SessionAuthorityManager {
  readonly ownerId: string;
  /**
   * Prove authority for a persisted session. Throws SessionAuthorityError
   * when the session is externally owned, the external owner is
   * unreachable, or another process holds the lease.
   */
  acquire(sessionId: string, sessionFile: string): Promise<AuthorityHandle>;
  /**
   * Prove authority and bind a synchronous SessionAppender to the held
   * authority. The returned handle's appendSessionEntries executes the
   * bound appender's methods synchronously while the lease mutex is held;
   * no per-call appender is accepted. Reentrant acquisition shares the held
   * authority only when the same appender instance is bound; a different or
   * missing binding is rejected.
   */
  acquireSessionAppender(
    sessionId: string,
    sessionFile: string,
    appender: SessionAppender,
  ): Promise<AppenderAuthorityHandle>;
  /**
   * Read-only ownership status (no acquisition). Used to decide whether a
   * viewer should connect a read-only observer stream.
   */
  status(sessionId: string, sessionFile: string): Promise<AuthorityStatus>;
}

export type AuthorityStatus =
  | "free"
  | "externally_owned"
  | "lease_held"
  | "authority_unverifiable";

export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;
export const EXTERNAL_RECHECK_MS = 10_000;
export const EXTERNAL_CHECK_TIMEOUT_MS = 1_500;
export const EXTERNAL_CHECK_CACHE_MS = 2_000;

export function sessionLeasePath(sessionFile: string): string {
  return `${sessionFile}.pi-web-lease.json`;
}

function isLeaseExpired(lease: SessionLease, now: number): boolean {
  return lease.expiresAt <= now;
}

function parseLease(raw: string): SessionLease | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionLease>;
    if (
      typeof parsed.ownerId !== "string"
      || typeof parsed.sessionId !== "string"
      || typeof parsed.sessionFile !== "string"
      || typeof parsed.acquiredAt !== "number"
      || typeof parsed.expiresAt !== "number"
      || typeof parsed.version !== "number"
      || typeof parsed.token !== "string"
    ) return null;
    return parsed as SessionLease;
  } catch {
    return null;
  }
}

// ============================================================================
// External owner client
// ============================================================================

export function createExternalOwnerClient(options: {
  baseUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): ExternalOwnerClient {
  const timeoutMs = options.timeoutMs ?? EXTERNAL_CHECK_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? EXTERNAL_CHECK_CACHE_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { status: ExternalOwnership; expiresAt: number }>();

  const configuredBaseUrl = (): string | undefined => {
    const raw = options.baseUrl ?? process.env.PI_WEB_EXTERNAL_OWNER_URL;
    return raw === undefined ? undefined : raw.replace(/\/+$/, "");
  };

  return {
    isConfigured(): boolean {
      const baseUrl = configuredBaseUrl();
      return baseUrl !== undefined && baseUrl !== "";
    },
    async check(sessionId: string, options: { fresh?: boolean } = {}): Promise<ExternalOwnership> {
      const baseUrl = configuredBaseUrl();
      if (baseUrl === undefined || baseUrl === "") return "free";
      if (!options.fresh) {
        const cached = cache.get(sessionId);
        if (cached && cached.expiresAt > now()) return cached.status;
      }

      let status: ExternalOwnership;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(
            `${baseUrl}/api/agent/${encodeURIComponent(sessionId)}`,
            { signal: controller.signal, cache: "no-store" },
          );
          if (!response.ok) {
            status = "unreachable";
          } else {
            const body = await response.json() as { running?: unknown };
            // Fail closed on any non-boolean shape: only an explicit
            // `running: false` proves the session is not owned elsewhere.
            if (body.running === true) status = "owned";
            else if (body.running === false) status = "free";
            else status = "unreachable";
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        status = "unreachable";
      }
      cache.set(sessionId, { status, expiresAt: now() + cacheTtlMs });
      return status;
    },
  };
}

// ============================================================================
// Authority manager
// ============================================================================

interface HeldAuthority {
  lease: SessionLease;
  leasePath: string;
  released: boolean;
  revoked: boolean;
  renewTimer: unknown;
  recheckTimer: unknown;
  revokeCallbacks: Array<() => void>;
  /** Original appender instance, for reentrant binding identity. */
  appender: SessionAppender | null;
  /** Method snapshot bound at acquisition; the authority invokes this, so a
   *  post-acquisition replacement of the appender's methods cannot redirect
   *  the fence to another session. */
  appenderMethods: SessionAppender | null;
}

export function createSessionAuthorityManager(
  deps: SessionAuthorityDeps,
): SessionAuthorityManager {
  const ownerId = randomUUID();
  const held = new Map<string, HeldAuthority>();
  // Lease paths with an in-flight release/revoke deletion, keyed by the lease
  // token the deletion belongs to; a re-acquire cancels it so a stale deletion
  // can never remove a newer lease generation.
  const pendingReleaseDeletions = new Map<string, string>();

  const stopTimers = (authority: HeldAuthority) => {
    deps.clearTimer(authority.renewTimer);
    deps.clearTimer(authority.recheckTimer);
  };

  const revoke = (authority: HeldAuthority) => {
    if (authority.released || authority.revoked) return;
    authority.revoked = true;
    stopTimers(authority);
    held.delete(authority.lease.sessionId);
    // Read-and-remove under the same lease mutex so a concurrent takeover
    // between the read and the unlink can never have its lease erased. The
    // pending marker also protects against a re-acquire reusing this lease
    // before the cleanup runs.
    pendingReleaseDeletions.set(authority.leasePath, authority.lease.token);
    void deps.lockLease(authority.leasePath).then((release) => {
      try {
        if (pendingReleaseDeletions.get(authority.leasePath) !== authority.lease.token) return;
        const current = deps.readLease(authority.leasePath);
        if (current?.ownerId === ownerId && current.token === authority.lease.token) {
          try {
            deps.removeLease(authority.leasePath);
          } catch {
            // Best effort; the lease expires on its own.
          }
        }
      } finally {
        release();
        if (pendingReleaseDeletions.get(authority.leasePath) === authority.lease.token) {
          pendingReleaseDeletions.delete(authority.leasePath);
        }
      }
    }).catch(() => {
      if (pendingReleaseDeletions.get(authority.leasePath) === authority.lease.token) {
        pendingReleaseDeletions.delete(authority.leasePath);
      }
      // Best effort; the lease expires on its own.
    });
    for (const callback of authority.revokeCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error(
          `[pi-web] authority revocation handler failed for ${authority.lease.sessionId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  };

  const renew = (authority: HeldAuthority) => {
    if (authority.released || authority.revoked) return;
    void deps.lockLease(authority.leasePath).then((release) => {
      try {
        if (authority.released || authority.revoked) return;
        const current = deps.readLease(authority.leasePath);
        if (!current || current.ownerId !== ownerId || current.token !== authority.lease.token) {
          revoke(authority);
          return;
        }
        const renewed: SessionLease = {
          ...current,
          expiresAt: deps.now() + LEASE_TTL_MS,
        };
        deps.replaceLease(authority.leasePath, renewed);
        authority.lease = renewed;
      } finally {
        release();
      }
    }).catch(() => {
      // Renewal could not be proven (lock contention, I/O failure): the lease
      // may expire under a live wrapper, so fail closed.
      revoke(authority);
    });
  };

  const recheckExternal = (authority: HeldAuthority) => {
    if (authority.released || authority.revoked) return;
    void deps.externalOwnership(authority.lease.sessionId, { fresh: true }).then((status) => {
      if (authority.released || authority.revoked) return;
      if (status === "owned" || status === "unreachable") {
        revoke(authority);
      }
    }).catch(() => {
      // A failed check cannot prove the external owner is absent: fail closed.
      revoke(authority);
    });
  };

  const appendSessionEntries = async (
    authority: HeldAuthority,
    operations: SessionAppendOperation[],
  ): Promise<string[]> => {
    if (!Array.isArray(operations)) {
      throw new TypeError("appendSessionEntries: operations must be an array");
    }
    // Snapshot the sequence before any await: the caller could mutate the
    // array, its operation objects, or nested payloads while the lease mutex
    // is pending, so the validation and the execution must both see the same
    // frozen sequence.
    const batch = structuredClone(operations);
    // Reject the whole sequence before any append runs: an invalid operation
    // must never leave a partial startup sequence behind.
    validateAppendOperations(batch);
    if (authority.released || authority.revoked) {
      throw new SessionAuthorityError(
        "lease_lost",
        `Mutation authority for session ${authority.lease.sessionId} was lost`,
      );
    }
    let release: () => void;
    try {
      release = await deps.lockLease(authority.leasePath);
    } catch {
      // The lease mutex could not be acquired: the lease cannot be proven
      // ours, so the mutation must not run.
      throw new SessionAuthorityError(
        "lease_lost",
        `Mutation authority for session ${authority.lease.sessionId} could not be fenced`,
      );
    }
    try {
      if (authority.released || authority.revoked) {
        throw new SessionAuthorityError(
          "lease_lost",
          `Mutation authority for session ${authority.lease.sessionId} was lost`,
        );
      }
      // The appender is bound at acquisition; only appender-bound handles
      // expose appendSessionEntries, so the binding is always present here.
      // The method snapshot is invoked (not the live appender object), so a
      // post-acquisition method replacement cannot redirect the fence.
      const appender = authority.appenderMethods!;
      const ids: string[] = [];
      for (const operation of batch) {
        // Re-read the exact lease generation and renew before every
        // operation: the mutex is held for the whole sequence, so the lease
        // cannot change between operations, but each append must be
        // authorized at its own start and the sequence must stop as soon as
        // authority is lost. No async executor remains after lock
        // acquisition: the appender calls below are synchronous.
        if (authority.released || authority.revoked) {
          throw new SessionAuthorityError(
            "lease_lost",
            `Mutation authority for session ${authority.lease.sessionId} was lost`,
          );
        }
        const current = deps.readLease(authority.leasePath);
        if (
          !current
          || current.ownerId !== ownerId
          || current.token !== authority.lease.token
          || current.version !== authority.lease.version
        ) {
          throw new SessionAuthorityError(
            "lease_lost",
            `Mutation authority for session ${authority.lease.sessionId} was lost`,
          );
        }
        if (isLeaseExpired(current, deps.now())) {
          throw new SessionAuthorityError(
            "lease_lost",
            `Mutation authority for session ${authority.lease.sessionId} expired`,
          );
        }
        const renewed: SessionLease = { ...current, expiresAt: deps.now() + LEASE_TTL_MS };
        deps.replaceLease(authority.leasePath, renewed);
        authority.lease = renewed;
        let id: unknown;
        try {
          id = operation.kind === "custom_entry"
            ? appender.appendCustomEntry(operation.customType, operation.data)
            : appender.appendSessionInfo(operation.name);
        } catch (error) {
          // A later synchronous SDK append failed after earlier operations
          // were applied: report the partial application explicitly. The
          // caller must not retry the sequence (entries would duplicate).
          throw new SessionAppendError(
            ids.length,
            `appendSessionEntries: appender failed after ${ids.length} applied operation(s)`,
            { cause: error },
          );
        }
        // The bound appender must return a string synchronously: a thenable
        // (async appender) or any non-string result fails immediately, while
        // the mutex is still held. This is an appender failure, so it carries
        // the partial-application count: a caller can distinguish a
        // pre-append rejection (appliedCount 0) from a partial write. A
        // thenable's rejection would otherwise be unhandled (the fence never
        // awaits it): swallow its settlement.
        if (typeof id !== "string") {
          if (id !== null && typeof (id as { then?: unknown }).then === "function") {
            void Promise.resolve(id).catch(() => {});
          }
          throw new SessionAppendError(
            ids.length,
            "appendSessionEntries: appender must return a string synchronously",
          );
        }
        ids.push(id);
      }
      return ids;
    } finally {
      release();
    }
  };

  const reentrantHandle = (existing: HeldAuthority, withAppend: boolean): AuthorityHandle => ({
    sessionId: existing.lease.sessionId,
    isHeld(): boolean {
      return !existing.released && !existing.revoked;
    },
    release(): void {
      // The primary handle owns the lease.
    },
    onRevoked(callback: () => void): void {
      if (existing.revoked) {
        callback();
        return;
      }
      existing.revokeCallbacks.push(callback);
    },
    ...(withAppend ? {
      appendSessionEntries(operations: SessionAppendOperation[]): Promise<string[]> {
        return appendSessionEntries(existing, operations);
      },
    } : {}),
  });

  const hold = (lease: SessionLease, leasePath: string, appender: SessionAppender | null): AuthorityHandle => {
    const existing = held.get(lease.sessionId);
    if (existing && !existing.released && !existing.revoked) {
      // Reentrant acquisition in this process (e.g. a one-shot mutation route
      // while the session wrapper already holds authority): share the
      // underlying authority. Releasing the secondary handle must not drop
      // the lease the primary holder still depends on. An appender binding
      // is preserved exactly: a different or missing binding is rejected, so
      // a reentrant handle can never silently use another child/session
      // appender. The session file identity must match too, so mutations can
      // never be routed to a different file for the same id.
      if (existing.lease.sessionFile !== lease.sessionFile) {
        throw new SessionAuthorityError(
          "lease_held",
          `Session ${lease.sessionId} is already held for a different session file`,
        );
      }
      if (appender !== null) {
        if (existing.appender === null) {
          throw new SessionAuthorityError(
            "lease_held",
            `Session ${lease.sessionId} is already held without an appender binding`,
          );
        }
        if (existing.appender !== appender) {
          throw new SessionAuthorityError(
            "lease_held",
            `Session ${lease.sessionId} is already held with a different appender binding`,
          );
        }
      }
      return reentrantHandle(existing, appender !== null);
    }

    const authority: HeldAuthority = {
      lease,
      leasePath,
      released: false,
      revoked: false,
      renewTimer: null,
      recheckTimer: null,
      revokeCallbacks: [],
      appender,
      appenderMethods: appender === null ? null : {
        appendCustomEntry: appender.appendCustomEntry.bind(appender),
        appendSessionInfo: appender.appendSessionInfo.bind(appender),
      },
    };
    held.set(lease.sessionId, authority);
    const scheduleRenew = () => {
      authority.renewTimer = deps.setTimer(() => {
        renew(authority);
        if (!authority.released && !authority.revoked) scheduleRenew();
      }, LEASE_RENEW_MS);
    };
    const scheduleRecheck = () => {
      authority.recheckTimer = deps.setTimer(() => {
        recheckExternal(authority);
        if (!authority.released && !authority.revoked) scheduleRecheck();
      }, EXTERNAL_RECHECK_MS);
    };
    scheduleRenew();
    scheduleRecheck();

    return {
      sessionId: lease.sessionId,
      isHeld(): boolean {
        return !authority.released && !authority.revoked;
      },
      release(): void {
        if (authority.released || authority.revoked) return;
        authority.released = true;
        stopTimers(authority);
        held.delete(lease.sessionId);
        pendingReleaseDeletions.set(leasePath, lease.token);
        void deps.lockLease(leasePath).then((release) => {
          try {
            if (pendingReleaseDeletions.get(leasePath) !== lease.token) return; // cancelled by a re-acquire
            const current = deps.readLease(leasePath);
            // Only remove the exact lease generation this handle acquired; a
            // re-acquisition may have replaced it with a newer lease.
            if (current && current.ownerId === ownerId && current.token === lease.token) {
              try {
                deps.removeLease(leasePath);
              } catch {
                // Best effort; the lease expires on its own.
              }
            }
          } finally {
            release();
            if (pendingReleaseDeletions.get(leasePath) === lease.token) {
              pendingReleaseDeletions.delete(leasePath);
            }
          }
        }).catch(() => {
          if (pendingReleaseDeletions.get(leasePath) === lease.token) {
            pendingReleaseDeletions.delete(leasePath);
          }
          // Best effort; the lease expires on its own.
        });
      },
      onRevoked(callback: () => void): void {
        if (authority.revoked) {
          callback();
          return;
        }
        authority.revokeCallbacks.push(callback);
      },
      ...(appender !== null ? {
        appendSessionEntries(operations: SessionAppendOperation[]): Promise<string[]> {
          return appendSessionEntries(authority, operations);
        },
      } : {}),
    };
  };

  const acquireWithAppender = async (
    sessionId: string,
    sessionFile: string,
    appender: SessionAppender | null,
  ): Promise<AuthorityHandle> => {
    const leasePath = sessionLeasePath(sessionFile);

    const external = await deps.externalOwnership(sessionId, { fresh: true });
    if (external === "owned") {
      throw new SessionAuthorityError(
        "externally_owned",
        `Session ${sessionId} is live in another Pi Web process`,
      );
    }
    if (external === "unreachable") {
      throw new SessionAuthorityError(
        "authority_unverifiable",
        `Cannot verify ownership of session ${sessionId}: external Pi Web is unreachable`,
      );
    }

    // Reentrant acquisition in this process shares the held authority before
    // any lease I/O: creating or replacing a lease for an already-held
    // session would orphan the active authority's generation (self-revoking
    // it on its next renewal) or leave a replacement lease behind on a
    // binding mismatch. Releasing the secondary handle must not drop the
    // lease the primary holder still depends on. The session file identity
    // must match too: a reentrant request for the same id but a different
    // file must never route mutations to the original file.
    const heldAuthority = held.get(sessionId);
    if (heldAuthority && !heldAuthority.released && !heldAuthority.revoked) {
      if (heldAuthority.lease.sessionFile !== sessionFile) {
        throw new SessionAuthorityError(
          "lease_held",
          `Session ${sessionId} is already held for a different session file`,
        );
      }
      if (appender !== null) {
        if (heldAuthority.appender === null) {
          throw new SessionAuthorityError(
            "lease_held",
            `Session ${sessionId} is already held without an appender binding`,
          );
        }
        if (heldAuthority.appender !== appender) {
          throw new SessionAuthorityError(
            "lease_held",
            `Session ${sessionId} is already held with a different appender binding`,
          );
        }
      }
      return reentrantHandle(heldAuthority, appender !== null);
    }

    const lease: SessionLease = {
      ownerId,
      sessionId,
      sessionFile,
      acquiredAt: deps.now(),
      expiresAt: deps.now() + LEASE_TTL_MS,
      version: 1,
      token: randomUUID(),
    };

    const existing = deps.readLease(leasePath);
    if (!existing) {
      pendingReleaseDeletions.delete(leasePath);
      try {
        deps.createLease(leasePath, lease);
        return hold(lease, leasePath, appender);
      } catch (error) {
        // Only a lost create race falls through to the locked takeover path;
        // any other filesystem failure must propagate.
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
    }

    const release = await deps.lockLease(leasePath);
    try {
      // Cancel any in-flight release deletion so it cannot remove the lease
      // this acquisition is about to reuse or replace.
      pendingReleaseDeletions.delete(leasePath);
      const current = deps.readLease(leasePath);
      // A fresh lease held by another owner blocks; our own leftover lease
      // (release raced or failed) is reused so release and renewal stay
      // bound to the same generation.
      if (current && !isLeaseExpired(current, deps.now()) && current.ownerId !== ownerId) {
        throw new SessionAuthorityError(
          "lease_held",
          `Session ${sessionId} is leased by another Pi Web process`,
        );
      }
      if (current && current.ownerId === ownerId && !isLeaseExpired(current, deps.now())) {
        return hold(current, leasePath, appender);
      }
      deps.replaceLease(leasePath, lease);
    } finally {
      release();
    }
    return hold(lease, leasePath, appender);
  };

  return {
    ownerId,
    acquire(sessionId: string, sessionFile: string): Promise<AuthorityHandle> {
      return acquireWithAppender(sessionId, sessionFile, null);
    },
    async acquireSessionAppender(
      sessionId: string,
      sessionFile: string,
      appender: SessionAppender,
    ): Promise<AppenderAuthorityHandle> {
      if (
        typeof appender.appendCustomEntry !== "function"
        || typeof appender.appendSessionInfo !== "function"
      ) {
        throw new TypeError(
          "acquireSessionAppender: appender must provide appendCustomEntry and appendSessionInfo methods",
        );
      }
      // Reject async implementations before they can execute: an async
      // method's synchronous prefix can write before its first await, and
      // its deferred continuation would run after the fence releases. This
      // catches plain async functions; bound or transpiled async
      // implementations are caught by the runtime string check on the first
      // append.
      if (
        (appender.appendCustomEntry as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction"
        || (appender.appendSessionInfo as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction"
      ) {
        throw new TypeError("acquireSessionAppender: appender methods must be synchronous");
      }
      // hold() exposes appendSessionEntries exactly when an appender is
      // bound, so the downcast is safe for the non-null binding.
      return acquireWithAppender(sessionId, sessionFile, appender) as unknown as AppenderAuthorityHandle;
    },
    async status(sessionId: string, sessionFile: string): Promise<AuthorityStatus> {
      const external = await deps.externalOwnership(sessionId);
      if (external === "owned") return "externally_owned";
      if (external === "unreachable") return "authority_unverifiable";
      const lease = deps.readLease(sessionLeasePath(sessionFile));
      if (lease && !isLeaseExpired(lease, deps.now()) && lease.ownerId !== ownerId) {
        return "lease_held";
      }
      return "free";
    },
  };
}

// ============================================================================
// Real-process singleton (survives Next.js hot-reload via globalThis)
// ============================================================================

declare global {
  var __piSessionAuthority: SessionAuthorityManager | undefined;
}

const REAL_DEPS: SessionAuthorityDeps = {
  now: Date.now,
  externalOwnership: createExternalOwnerClient().check,
  readLease(leasePath) {
    try {
      return parseLease(readFileSync(leasePath, "utf8"));
    } catch {
      return null;
    }
  },
  createLease(leasePath, lease) {
    writeFileSync(leasePath, `${JSON.stringify(lease)}\n`, { flag: "wx" });
  },
  replaceLease(leasePath, lease) {
    const tempPath = `${leasePath}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(lease)}\n`);
    renameSync(tempPath, leasePath);
  },
  removeLease(leasePath) {
    unlinkSync(leasePath);
  },
  async lockLease(leasePath) {
    return lockfile.lock(leasePath, {
      realpath: false,
      stale: LEASE_TTL_MS,
      retries: { retries: 5, factor: 2, minTimeout: 50, maxTimeout: 500, randomize: true },
      onCompromised: () => {},
    });
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function getSessionAuthorityManager(): SessionAuthorityManager {
  if (!globalThis.__piSessionAuthority) {
    globalThis.__piSessionAuthority = createSessionAuthorityManager(REAL_DEPS);
  }
  return globalThis.__piSessionAuthority;
}

export function resetSessionAuthorityManagerForTests(): void {
  globalThis.__piSessionAuthority = undefined;
}
