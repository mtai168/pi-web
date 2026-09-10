# Session mutation authority across Pi Web processes

## Status

Accepted.

## Context

Pi Web (SST) and the separately installed official Pi Web package can run on
the same host and share the same persisted session directory
(`~/.pi/agent/sessions`). Both processes can open the same session JSONL.
Before this ADR, SST's `/api/agent/[id]/events` and `/api/agent/[id]` cold
start created an in-process `AgentSession` for any persisted session id, with
no coordination with the other process. Two processes holding the same
session simultaneously diverge in-memory (leaf ids, entry tails, message
counts, brain status) and can concurrently append, compact, fork, and
navigate — corrupting branch parentage and duplicating side effects.

The official package is installed separately and must not be modified in
place by this work, so it cannot be assumed to participate in any new
protocol. A point-in-time ownership check plus a periodic re-check cannot
close the window in which the unmodified official process acquires a session
between SST's checks: that residual window violates the zero-concurrent-writer
requirement, so it is a blocker, not an accepted risk.

## Decision

A persisted Pi session has exactly **one mutation authority** at a time
across Pi Web processes. The mode is chosen by configuration:

### External-owner mode (`PI_WEB_EXTERNAL_OWNER_URL` set)

The configured official Pi Web process is the **sole mutation authority** for
every session. SST never creates or retains a local writable `AgentSession`
for persisted or newly created user sessions, and never writes a session
JSONL. All operations SST needs are delegated to the official process over
HTTP through an explicit same-origin server-side proxy:

| SST route | Delegation target |
| --- | --- |
| `POST /api/agent/[id]` (commands) | `POST {base}/api/agent/[id]` |
| `GET /api/agent/[id]` (state) | `GET {base}/api/agent/[id]` |
| `GET /api/agent/[id]/events` (SSE) | `GET {base}/api/agent/[id]/events` |
| `POST /api/agent/new` (new sessions) | `POST {base}/api/agent/new` |
| `GET /api/agent/running` | `GET {base}/api/agent/running` |
| `PATCH /api/sessions/[id]` (rename) | `PATCH {base}/api/sessions/[id]` |
| `DELETE /api/sessions/[id]` | `DELETE {base}/api/sessions/[id]` |
| `GET /api/sessions/[id]/state` | `GET {base}/api/sessions/[id]/state` |
| `POST /api/sessions/[id]/auto-name` | `POST {base}/api/sessions/[id]/auto-name` |

Delegation properties:

- The target is always the validated configured base URL plus a fixed route
  suffix; session ids are path-escaped. Redirects are not followed, so the
  upstream can never steer the proxy to another host. This is an explicit
  single-owner proxy, not a generic SSRF surface. URLs with a query or
  fragment are rejected at configuration time, and every delegated request
  carries a marker header that the receiving routes reject, so a
  misconfigured delegation loop (the URL pointing back at this instance)
  fails closed instead of recursing until timeout.
- Upstream status and body are forwarded untouched; the client's abort
  signal is forwarded upstream so a disconnect cancels the upstream request
  or SSE stream. Only the content type is forwarded back; request
  credentials (Authorization/Cookie) are never forwarded cross-origin —
  there is no shared service-auth contract with the configured owner, and
  forwarding ambient caller credentials would let the owner evaluate a
  request under a different identity. An owner that requires authentication
  rejects the delegation — fail closed — rather than evaluating the request
  under a different identity. Delegation therefore does not claim support
  for protected upstream auth.
- The delegation marker header is a loop guard, not an authorization
  mechanism: it is client-spoofable, so every external-mode route rejects a
  request carrying it with 502 before any local mutation or delegation. It
  is never treated as permission to execute locally.
- Any delegation failure (unreachable, timeout, malformed configuration)
  **fails closed**: the operation returns an error and SST remains read-only.
  There is no local fallback — in particular, no local writable session and
  no local observer in external-owner mode, because running state must come
  from the sole authority, never from file mtime heuristics.
- `startRpcSession` throws `external_owner_mode` in external-owner mode, so
  no internal path (subagent creation, tool-selection persistence, session
  reopening) can create a local writable session even by accident.

Because the official process is the only writer, there is no takeover window:
a session cannot be acquired by two processes, because only one process ever
writes.

### Standalone mode (`PI_WEB_EXTERNAL_OWNER_URL` unset)

SST is the only Pi Web process family on the host. The sidecar lease
coordinates SST processes:

1. **Lease.** SST writes an atomic sidecar lease file next to the session
   JSONL (`<sessionFile>.pi-web-lease.json`) containing a random owner UUID
   (never a PID), the session identity, an expiry, and a version. A fresh
   lease held by another owner → fail closed. An expired lease (crashed
   owner) may be taken over under a `proper-lockfile` mutex. While held, the
   lease is renewed every 10 s (30 s TTL). Release and revocation
   read-and-remove the lease under the same mutex so a concurrent takeover
   can never have its lease erased, and a pending release deletion is
   cancelled by a re-acquisition so it can never remove a newer lease
   generation. Reentrant acquisition within one process shares the held
   authority instead of creating a second independent handle.

2. **Every persisted writable wrapper holds a handle.** This includes
   subagent sessions: the subagent runtime proves authority for the child
   JSONL before its first append and passes the handle to the wrapper, which
   releases it on shutdown and is marked unavailable synchronously on
   revocation. A wrapper is never published without a valid handle.

3. **Fenced appends.** Direct JSONL appends are never preceded by a bare
   `isHeld()` check: a revocation could interleave between the check and the
   write. `acquireSessionAppender(sessionId, sessionFile, appender)` proves
   authority and binds a narrow synchronous `SessionAppender` to the held
   authority; the resulting handle exposes `appendSessionEntries(operations)`
   only — no appender, callback, function, thunk, promise, or thenable is
   accepted per call. The operation is a **closed discriminated union**
   (`custom_entry` and `session_info`) executed by the authority itself
   against the bound appender, so no mutation can escape the fence or defer
   work past its release. The sequence is deep-cloned before the lease-mutex
   await, invalid operations reject the whole sequence before any append
   runs, and the appender's `appendCustomEntry`/`appendSessionInfo` methods
   are executed **synchronously while the lease mutex is held** — there is no
   async executor after lock acquisition, so no awaited appender can outlive
   the fence or write after lease expiry/revocation. The exact
   owner/token/version is re-read and the lease renewed before every
   operation, and a thenable or non-string appender result fails immediately.
   Reentrant acquisition shares the held authority only when the same
   appender instance is bound; a different or missing binding is rejected, so
   a reentrant handle can never silently use another child/session appender.
   The appender's methods are snapshotted (bound to the appender) at
   acquisition and the authority invokes the snapshot, so a post-acquisition
   replacement of the appender's methods cannot redirect the fence. The
   runtime string check enforces the synchronous contract against accidental
   async appenders; it cannot prevent a hostile async implementation's
   synchronous prefix from writing before its first `await` — that is the
   trusted-implementation boundary below, not a defense against arbitrary
   hostile JS objects. Reentrant acquisition still probes the external owner
   first and fails closed on `owned`/`unreachable`, consistent with the
   active authority's own re-check, so a reentrant handle is never handed
   out for an authority the external owner has taken over.

   The sequence is **ordered, not atomic**: the SDK offers no rollback, so a
   later synchronous append failure throws `SessionAppendError` carrying
   `appliedCount` (earlier entries stay applied — inert metadata that cannot
   duplicate side effects), and callers must never retry a failed sequence.
   `appliedCount` counts the operations whose appender call returned; the
   failing operation's own commit state is unknown (the appender may have
   written before throwing), so it is a diagnostic, never a retry signal.
   Appender calls are assumed bounded well below `LEASE_TTL_MS`: the lease
   mutex fences takeovers for any append shorter than the lock-stale
   threshold, and the synchronous `SessionManager` appender is a short file
   append, so a blocking call long enough to let a takeover break the lock
   mid-write is not reachable in production.
   The appender is the caller's `SessionManager` instance (its in-memory
   leaf/index state must stay linked to the wrapper). This is an in-process
   trusted capability: the authority boundary protects cross-process lease
   ownership, not malicious code already executing in-process — a caller that
   deliberately fabricates a hostile appender can bypass the fence, but such
   a caller already holds the session file path and can write it directly.
   The fence is a cooperation boundary that makes accidental escape
   impossible, not a defense against arbitrary hostile JS objects. The
   subagent runtime uses one fenced sequence for the initial metadata +
   `session_info` appends and one for the completion/result append; a
   rejected fence writes nothing and leaves no published wrapper or lease,
   and a failed startup append aborts startup, releases the authority, and is
   never retried, so entries are never duplicated.

### Read-only observation (standalone mode)

When authority cannot be proven (leased elsewhere), SST never creates a
writable `AgentSession` merely to observe. `GET /api/agent/[id]/events`
serves a **read-only observer** that polls the JSONL and emits
client-compatible events: a full `session_snapshot` on
connect/reconnect/rewrite, `message_end` for appended messages,
`agent_start`/`agent_settled` for brain status derived from append activity,
`compaction_start`/`compaction_end`, and `session_info` for name changes
(which also invalidates the session-list cache and refreshes the snapshot).
The observer never writes the JSONL. It applies only forward progress:

- Strict appends are applied incrementally only when they continue the
  active branch (each new entry's parent is the previously applied entry);
  a branch switch or any other off-branch append reconciles through a full
  snapshot instead, so the leaf never advances to an entry outside the
  active branch.
- Torn lines are deferred; a complete-but-malformed tail never advances the
  applied offset and is re-checked on a stability timer, so a repaired entry
  is observed promptly instead of waiting for the periodic forced read.
  Permanently malformed/cyclic content backs off (200, 400, 800, 1600,
  1600 ms) and stops after a bounded retry budget, returning to the normal
  1 s poll; any content change resets the budget, and the periodic forced
  read still detects a same-size/same-mtime repair within a bounded
  interval.
- Full rewrites are re-snapshotted only after the file is stable and
  re-validated against the last applied state; a mid-write truncation is
  never applied.
- Full snapshots and incremental tails are validated before any SDK context
  traversal: unique string ids, no self-references, and no cyclic parent
  chains (the SDK's context walkers hang on cycles).
- The initial `running` flag is evidence-based: a fresh mtime claims
  running, a stale mtime claims nothing (`undefined`), so the observer never
  infers authoritative idle solely from mtime. Idle is only claimed after
  observed activity settles.

### Fail-closed mutation (standalone mode)

`POST /api/agent/[id]` returns `403` with a clear error when authority is
absent or ambiguous, for every command — including read-only commands that
would require constructing a writable session. Prompts additionally return
`code: "prompt_rejected", accepted: false` so the client rolls back its
optimistic message. Nothing is appended to the JSONL. `PATCH` (rename) and
`DELETE` on `/api/sessions/[id]` are mutations too and fail closed the same
way.

`DELETE` is a single-file operation: it proves authority, shuts down a live
local wrapper, re-acquires the lease as a fence (if another process took the
lease in the shutdown window, the delete fails closed instead of unlinking
underneath it), re-verifies the handle immediately before the unlink, and
unlinks. Cascade re-parenting of child sessions rewrites multiple files and
cannot be made atomic here, so it **fails closed before any write**: a
delete of a session that has children returns `409` and leaves every file
untouched. A safe rejection is preferable to partial tree corruption.

## Trust and failure model

| Situation | Behavior |
| --- | --- |
| External-owner mode, authority reachable | All mutations delegated to the official process; SST read-only locally. |
| External-owner mode, authority unreachable | Operations fail closed (502); SST remains read-only; no local fallback. |
| Standalone, lease held by another SST process | SST read-only (observer). |
| Owner crashes | Lease expires (≤ 30 s); takeover is time-based, no PID/ancestry guesswork. |
| Owner's renewal delayed past TTL | Lease may be taken over; the old owner's next renewal detects the foreign owner and revokes. |
| Standalone, subagent child lease held elsewhere | Subagent creation fails closed before the first append. |
| `PI_WEB_EXTERNAL_OWNER_URL` unset | Single-process family mode: lease coordinates SST instances. |

A writer pausing more than 200 ms mid-rewrite could yield a transient partial
snapshot to observers; the next stable state corrects it. The SDK's rewrites
are tight loops, so this is not observed in practice.

## Consequences

- External-owner mode: SST is a pure read-only viewer plus delegation proxy;
  zero concurrent writers by construction (only the official process writes).
- Standalone mode: persisted sessions are writable only with a proven lease;
  subagent wrappers are authority-bound; everything else is read-only with a
  live wall-pane view.
- New (not yet persisted) sessions, forks, and clones in standalone mode
  create new files and need no authority.
- The official package needs no modification and no lease participation.
