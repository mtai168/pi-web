import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { delegateExternalOwnerRequest, forwardExternalOwnerResponse, isDelegatedRequest, isExternalOwnerMode } from "@/lib/external-owner";
import { authorityErrorMessage, isSessionAuthorityError } from "@/lib/session-authority";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
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
    // Renaming is a mutation: delegate to the sole authority.
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/sessions/${encodeURIComponent(id)}/auto-name`,
        {
          method: "POST",
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
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
