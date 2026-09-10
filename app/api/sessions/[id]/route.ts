import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession } from "@/lib/rpc-manager";
import { authorityErrorMessage, getSessionAuthorityManager, isSessionAuthorityError, SessionAuthorityError } from "@/lib/session-authority";
import { delegateExternalOwnerRequest, forwardExternalOwnerResponse, isDelegatedRequest, isExternalOwnerMode } from "@/lib/external-owner";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      stats,
      totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (isExternalOwnerMode()) {
    if (isDelegatedRequest(req)) {
      // The configured owner points back at this instance: fail closed
      // instead of recursing until timeout.
      return NextResponse.json({
        error: "Delegation loop detected",
        code: "authority_required",
        authority: "authority_unverifiable",
      }, { status: 502 });
    }
    // Renaming appends to the JSONL: delegate to the sole authority.
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/sessions/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": req.headers.get("content-type") ?? "application/json" },
          body: await req.text(),
          signal: req.signal,
        },
      );
      return forwardExternalOwnerResponse(upstream);
    } catch (error) {
      if (req.signal.aborted) {
        // The client disconnected, but the upstream may already have applied
        // the rename: the outcome is unknown, so fail closed explicitly.
        return NextResponse.json({
          error: "The mutation outcome is unknown because the request was cancelled.",
          code: "authority_required",
          authority: "authority_unverifiable",
        }, { status: 502 });
      }
      return NextResponse.json({
        error: isSessionAuthorityError(error)
          ? authorityErrorMessage(error)
          : "The configured Pi Web process could not be reached; the session is read-only here.",
        code: "authority_required",
        authority: "authority_unverifiable",
      }, { status: 502 });
    }
  }
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Renaming appends a session_info entry to the JSONL: it is a mutation
    // and needs proven authority.
    const authority = await getSessionAuthorityManager().acquire(id, filePath);
    try {
      if (!authority.isHeld()) {
        throw new SessionAuthorityError("lease_lost", `Mutation authority for session ${id} was lost`);
      }
      const sm = SessionManager.open(filePath);
      sm.appendSessionInfo(name.trim());
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    } finally {
      authority.release();
    }
  } catch (error) {
    if (isSessionAuthorityError(error)) {
      return NextResponse.json({
        error: authorityErrorMessage(error),
        authority: error.code,
        code: "authority_required",
      }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (isExternalOwnerMode()) {
    if (isDelegatedRequest(req)) {
      // The configured owner points back at this instance: fail closed
      // instead of recursing until timeout.
      return NextResponse.json({
        error: "Delegation loop detected",
        code: "authority_required",
        authority: "authority_unverifiable",
      }, { status: 502 });
    }
    // Deleting (and cascade-reparenting children) is a mutation: delegate to
    // the sole authority.
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE", signal: req.signal },
      );
      return forwardExternalOwnerResponse(upstream);
    } catch (error) {
      if (req.signal.aborted) {
        // The client disconnected, but the upstream may already have applied
        // the delete: the outcome is unknown, so fail closed explicitly.
        return NextResponse.json({
          error: "The mutation outcome is unknown because the request was cancelled.",
          code: "authority_required",
          authority: "authority_unverifiable",
        }, { status: 502 });
      }
      return NextResponse.json({
        error: isSessionAuthorityError(error)
          ? authorityErrorMessage(error)
          : "The configured Pi Web process could not be reached; the session is read-only here.",
        code: "authority_required",
        authority: "authority_unverifiable",
      }, { status: 502 });
    }
  }
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Deleting a session is a mutation: it needs proven authority so a
    // session controlled by another Pi Web process cannot be deleted
    // underneath it.
    const authority = await getSessionAuthorityManager().acquire(id, filePath);
    try {
      if (!authority.isHeld()) {
        throw new SessionAuthorityError("lease_lost", `Mutation authority for session ${id} was lost`);
      }

      // Cascade re-parenting rewrites every child header: that is a
      // multi-file transaction that cannot be made atomic here, so it fails
      // closed BEFORE any write. A safe rejection is preferable to a
      // partially reparented tree. An unreadable or malformed candidate is
      // a deletion error too: it may be a child whose parent cannot be
      // inspected, and deleting the parent would orphan it.
      const targetPathKey = sessionPathKey(filePath);
      const dir = dirname(filePath);
      const rejectIfChildren = (): Response | null => {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".jsonl") || sessionPathKey(join(dir, file)) === targetPathKey) continue;
          const childPath = join(dir, file);
          let header: { type?: string; parentSession?: string };
          try {
            header = JSON.parse(readFileSync(childPath, "utf8").split("\n")[0]) as { type?: string; parentSession?: string };
          } catch (error) {
            // Fail closed: the file may be a child whose parent cannot be
            // inspected. Log the path server-side only.
            console.error("Cannot inspect session file before deletion", { childPath, error });
            throw new Error("Cannot inspect session files before deletion");
          }
          if (header.type === "session" && header.parentSession && sessionPathKey(header.parentSession) === targetPathKey) {
            return NextResponse.json({
              error: "Cannot delete a session that has child sessions; delete or re-parent the children first.",
              code: "delete_blocked_children",
            }, { status: 409 });
          }
        }
        return null;
      };
      const blocked = rejectIfChildren();
      if (blocked) return blocked;

      // Shut down a live local wrapper first so it cannot append to the file
      // after the unlink and no new subagent can be created from it. Its
      // shutdown releases the shared lease, so re-acquire as a fence: if
      // another process took the lease in the window, the delete fails
      // closed instead of unlinking underneath it.
      await getRpcSession(id)?.shutdown();
      const fenced = await getSessionAuthorityManager().acquire(id, filePath);
      try {
        if (!fenced.isHeld()) {
          throw new SessionAuthorityError("lease_lost", `Mutation authority for session ${id} was lost`);
        }
        // Re-check children immediately before the unlink: with the fence
        // held no other process can hold a live wrapper for this parent, and
        // the local wrapper is shut down, so a child appearing after this
        // scan would orphan it.
        const blockedAfterFence = rejectIfChildren();
        if (blockedAfterFence) return blockedAfterFence;
        unlinkSync(filePath);
      } finally {
        fenced.release();
      }
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    } finally {
      authority.release();
    }
  } catch (error) {
    if (isSessionAuthorityError(error)) {
      return NextResponse.json({
        error: authorityErrorMessage(error),
        authority: error.code,
        code: "authority_required",
      }, { status: 403 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
