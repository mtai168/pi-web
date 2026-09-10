# Cross-process session authority contract (owner decision)

## Status

Proposed — owner decision required. Supersedes the implementation reading of
ADR 0004: the R2 implementation (commits `cf87dfb..d1b0e11` on base
`506b712`) proved the two-proof model cannot close the concurrent-writer
window against the unmodified official Pi Web process, and R2 terminated
without a valid handoff report. ADR 0004's "residual window" is therefore
reclassified as a **blocker**, not a bounded risk.

## Context

SST and the separately installed official Pi Web 0.9.0 (unmodified, port
8504) share `~/.pi/agent/sessions`. ADR 0004 decided exactly one mutation
authority per persisted session, proven by (1) an external-owner probe of the
official process's `GET /api/agent/[id]` and (2) a sidecar lease
(`<sessionFile>.pi-web-lease.json`, 30 s TTL, 10 s renewal, 10 s re-check).
R2 implemented this plus a read-only JSONL observer and fail-closed routes.

Four OCR rounds reviewed the R2 diff (21 + 15 + 16 + 15 findings). Round 4
still reports actionable High findings, all variants of one root cause: **the
sidecar lease is not coordinated with the unmodified official process, and
the external-owner probe is a point-in-time observation, so exclusivity can
never be proven at acquisition time or held across a write.**

Concrete evidence (HEAD `d1b0e11`):

- `lib/session-authority.ts:450-451` — the external check and the lease
  create are separate operations; the official process can claim the session
  between them. The official process does not participate in the lease
  protocol, so the lease proves nothing against it. `status()` at
  `lib/session-authority.ts:511-518` uses a cached (2 s) probe.
- `lib/rpc-manager.ts:549-555` — the authority gate runs before `send()`
  enters; an already-admitted SDK command can still append JSONL after
  revocation hands ownership over.
- `lib/rpc-manager.ts:1741` — the subagent `registerSession` path registers
  a persisted wrapper with **no authority handle** (`registerRpcWrapper(wrapper)`),
  so a subagent child JSONL is writable with no lease and no revocation gate.
- `app/api/sessions/[id]/route.ts:131-135` (PATCH) and `:239-243` (DELETE) —
  `isHeld()` is checked before, but not held across, the JSONL write
  (`writeFileSync` at `:269`, `unlinkSync` at `:277`).
- `app/api/sessions/[id]/route.ts:202-215` — the child scan skips unreadable
  or malformed `.jsonl` files (`continue; // skip malformed`) and then deletes
  the parent, orphaning children; `:273-286` rollback is best-effort and can
  overwrite a concurrent change — the delete/re-parent is not transactional.
- `app/api/agent/[id]/events/route.ts:28-38` — the fast path accepts any
  cached alive wrapper without revalidating authority, so a revoked wrapper
  can still serve mutation.
- `app/api/sessions/[id]/state/route.ts:25-29` — the writability read is
  separate from the events handshake; the client can enable writes on a
  stale `free` answer.
- `lib/session-observer.ts:215` — the initial `running` flag is an mtime
  heuristic, not an activity signal; `:458-459` — a rejected malformed tail
  schedules no retry, so a repaired file can stay stale.

## Decision required: two bounded paths

### Path A — shared atomic authority handshake

Both SST and the official 8504 Pi Web implement one protocol. Exact contract:

- **Claim.** Atomic create of a lease file next to the JSONL
  (`<file>.pi-web-lease.json`): owner UUID, session id, acquired-at, expiry,
  version, token. `EEXIST` on a fresh foreign lease → reject; expired lease →
  takeover under a per-path mutex. Claim must be the *only* admission gate
  for a writable `AgentSession` in both processes.
- **Renewal.** Periodic renew under the same mutex; renewal failure or a
  foreign owner → synchronous revocation (fail closed).
- **Revocation.** Synchronous: mark the wrapper unavailable, remove it from
  the registry, and gate every in-flight command at its JSONL write boundary
  before ownership can be handed over.
- **Mutation fencing.** Every JSONL write (append, rename, delete,
  re-parent, subagent registration) revalidates the held, generation-bound
  lease immediately before the write; multi-file mutations are transactional
  or abort before the first write.
- **Crash recovery.** TTL expiry + mutex takeover; no PID/ancestry guessing.
- **Identity.** Random owner UUID per process, token per acquisition;
  release/revoke only remove the exact generation they own.
- **Compatibility rollout.** Both processes must be upgraded in lockstep; a
  mixed-version pair degrades to Path B behavior (read-only) for shared
  sessions.

**Why the current 8504 process cannot satisfy Path A:** it contains no lease
code, no claim/renew/revoke endpoints, and no write fencing; its
`/api/agent/[id]` is an in-memory status report, not a claim on a shared
lease. SST's probe of it is read-only and cached. Path A therefore requires
changing the official installation, which the frozen constraints forbid this
Hand from doing and ADR 0004 explicitly ruled out ("must not be modified in
place by this work").

### Path B — fail-closed boundary for the unmodified official process

SST treats the official process as an uncoordinated external writer and
never claims exclusivity against it:

- **Observation authority.** SST may serve read-only observer streams for
  any persisted JSONL it does not hold mutation authority over. The observer
  never writes; it applies only forward progress and re-snapshots on
  connect/rewrite. Reconnect and metadata refresh (rename, labels) happen
  through the observer without creating an `AgentSession`.
- **Mutation authority.** When an external owner is configured, SST must
  reject mutation of any persisted session the official process could open —
  as `externally_owned`, `authority_unverifiable`, or `ambiguous` — because
  exclusivity cannot be proven by any point-in-time probe. A `running: false`
  answer is **not** proof of future exclusivity and must never be described
  as one.
- **Local-only mode.** With `PI_WEB_EXTERNAL_OWNER_URL` unset, single-process
  behavior is preserved, but only as an explicit, testable local-only mode:
  the lease still coordinates SST instances, and the mode must be documented
  as unsafe against any process that ignores the lease. It is not a claim of
  exclusivity.
- **Migration/operational limitation.** Persisted sessions shared with the
  official process are read-only in SST until the official installation is
  upgraded to Path A or isolated (separate session directories, or the
  official process removed). This limitation is the price of not modifying
  8504.

## Safety invariants (both paths)

1. Exactly one mutation authority per persisted session at any instant,
   enforced by a protocol both writers implement; a probe is never proof.
2. No JSONL write without a held, generation-bound authority revalidated at
   the write boundary (fencing).
3. Revocation is synchronous and gates in-flight work; no write may overlap
   ownership handover.
4. Multi-file mutations (delete/re-parent) are transactional or abort before
   any write; no orphaned children.
5. Observation never mutates; observers apply only forward progress.
6. Unverifiable ⇒ read-only, never writable (fail closed).

## Trust and failure model

| Situation | Behavior |
| --- | --- |
| Official process reports session live | SST read-only (observer). |
| Official process unreachable / non-boolean shape | SST read-only; held authority revoked. |
| Lease held by another SST instance | SST read-only (observer). |
| Owner crashes | Lease expires (≤ 30 s); time-based takeover. |
| Official process opens a session SST holds | Undetectable at acquisition; only the 10 s re-check notices, after concurrent writes may already have occurred — **blocker under Path B, eliminated only by Path A**. |
| External owner configured | Persisted-session mutation rejected (Path B) or protocol-coordinated (Path A). |
| External owner unset | Local-only mode; lease coordinates SST instances only. |

## Requirements that cannot be met without changing the official 8504 installation

- Mutating persisted sessions while the official process may open them.
- Closing the acquisition-time takeover window (TOCTOU between probe and
  claim).
- Coordinated revocation/fencing so ownership handover never overlaps a
  write.

## Owner decision points

1. **Select the implementation path.** Recommended: **Path B** — it is the
   only path implementable under the frozen constraints (no 8504 changes, no
   live testing) and the only one that removes the concurrent-writer risk
   today. Path A is the migration end-state, not an immediate option.
2. **Authorize or defer the official 8504 change.** Path A is the only way to
   restore mutation of shared persisted sessions; it requires a separate
   owner decision to modify the official installation and a lockstep rollout.
3. **Confirm local-only mode semantics.** Single-process behavior survives
   only as the explicit, testable local-only mode; confirm that shared
   persisted sessions being read-only in SST is acceptable until Path A.

## Next-Hand contract (Path B, smallest bounded scope)

One implementation Hand, frozen to: `lib/session-authority.ts`,
`lib/session-observer.ts`, `lib/rpc-manager.ts`,
`app/api/sessions/[id]/route.ts`, `app/api/sessions/[id]/state/route.ts`,
`app/api/agent/[id]/events/route.ts`, and their unit tests. No live services,
no 8504 changes.

1. With an external owner configured, reject mutation of persisted sessions
   (`PATCH`/`DELETE`/prompt cold start) as externally-owned or ambiguous;
   keep the observer as the only served mode.
2. Events fast path revalidates authority before serving a cached wrapper;
   the state route never advertises writability it cannot prove.
3. Subagent registration acquires and holds the child's authority handle.
4. DELETE aborts on any unreadable/malformed child and holds authority
   across every write; no best-effort rollback that can overwrite a
   concurrent change.
5. Observer: retry scheduling after a rejected tail, deduplicated incremental
   events, metadata refresh without `AgentSession` creation.
6. Deterministic unit tests for 1-5 (no ports, no real sessions); acceptance
   is OCR clean of actionable High/Medium findings and a diff that never
   claims exclusivity against the official process.

## Consequences

- SST becomes read-only for shared persisted sessions until Path A — the
  honest cost of the fail-closed boundary.
- The sidecar lease remains an SST-internal coordination mechanism; it is
  **not** described as coordinated with the unmodified 8504 process.
- Unresolved concurrent-writer or destructive stale-lock risk remains a
  blocker for any path that mutates shared persisted sessions without Path A.
