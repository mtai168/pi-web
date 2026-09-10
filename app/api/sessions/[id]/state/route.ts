import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { getSessionAuthorityManager } from "@/lib/session-authority";
import { delegateExternalOwnerRequest, forwardExternalOwnerResponse, isDelegatedRequest, isExternalOwnerMode } from "@/lib/external-owner";
import { authorityErrorMessage, isSessionAuthorityError } from "@/lib/session-authority";

async function markExternalOwnerReadOnly(upstream: Response): Promise<Response> {
  if (!upstream.ok) return forwardExternalOwnerResponse(upstream);

  const body = await upstream.text();
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  try {
    const payload = JSON.parse(body) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new Response(JSON.stringify({
        ...(payload as Record<string, unknown>),
        readOnly: true,
        authority: "external_owner",
      }), { status: upstream.status, headers });
    }
  } catch {
    // Preserve an invalid upstream body; the official route owns its contract.
  }

  return NextResponse.json({
    error: "The configured Pi Web process returned invalid session state; the session is read-only here.",
    code: "authority_required",
    authority: "authority_unverifiable",
  }, { status: 502 });
}

export async function GET(
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
    // Running state is sourced from the sole authority, never inferred here.
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/sessions/${encodeURIComponent(id)}/state`,
        { signal: req.signal },
      );
      return markExternalOwnerReadOnly(upstream);
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
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Not running here. Report whether the session is externally owned or
    // ambiguous so viewers can connect a read-only observer stream instead
    // of a writable AgentSession.
    const status = await getSessionAuthorityManager().status(id, filePath);
    return NextResponse.json({
      running: false,
      ...(status !== "free" ? { readOnly: true, authority: status } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
