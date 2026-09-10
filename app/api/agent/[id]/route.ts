import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { authorityErrorMessage, isSessionAuthorityError } from "@/lib/session-authority";
import { delegateExternalOwnerRequest, forwardExternalOwnerResponse, isDelegatedRequest, isExternalOwnerMode } from "@/lib/external-owner";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
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
    // The configured official Pi Web is the sole mutation authority: every
    // command is delegated to it. A delegation failure fails closed — the
    // command never falls back to a local writable session.
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/agent/${encodeURIComponent(id)}`,
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
        // the mutation: the outcome is unknown, so fail closed explicitly.
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
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isSessionAuthorityError(error)) {
      // Fail closed: no proven mutation authority, so no command may run and
      // nothing may be appended to the session JSONL.
      return NextResponse.json({
        error: authorityErrorMessage(error),
        authority: error.code,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : { code: "authority_required" }),
      }, { status: 403 });
    }
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
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
    // Running state is sourced from the sole authority, never inferred here.
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/agent/${encodeURIComponent(id)}`,
        { signal: req.signal },
      );
      return forwardExternalOwnerResponse(upstream);
    } catch (error) {
      if (req.signal.aborted) return new Response(null, { status: 204 });
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
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
