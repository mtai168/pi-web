import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { isSessionAuthorityError } from "@/lib/session-authority";
import { createSessionObserver } from "@/lib/session-observer";
import { delegateExternalOwnerRequest, forwardExternalOwnerResponse, isDelegatedRequest, isExternalOwnerMode } from "@/lib/external-owner";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  if (isExternalOwnerMode()) {
    if (isDelegatedRequest(req)) {
      // The configured owner points back at this instance: fail closed
      // instead of recursing until timeout.
      return new Response("Delegation loop detected", { status: 502 });
    }
    // The configured official Pi Web is the sole authority: its event stream
    // is proxied verbatim. The client's signal is forwarded upstream so a
    // disconnect cancels the upstream stream; an unreachable authority fails
    // closed (no local observer, no local writable session).
    try {
      const upstream = await delegateExternalOwnerRequest(
        `/api/agent/${encodeURIComponent(id)}/events`,
        {
          headers: { Accept: "text/event-stream" },
          signal: req.signal,
          bodyTimeoutMs: 0,
        },
      );
      if (!upstream.ok) {
        // The official process answered: preserve its status/body.
        return forwardExternalOwnerResponse(upstream);
      }
      if (!upstream.body) {
        return new Response("External agent stream unavailable", { status: 502 });
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    } catch {
      if (req.signal.aborted) return new Response(null, { status: 204 });
      return new Response(
        "External agent stream unavailable",
        { status: 502 },
      );
    }
  }

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined)
      .then((result) => result.session)
      .catch((error) => {
        // No mutation authority (leased elsewhere, or unverifiable): observe
        // the JSONL read-only instead of creating a second writable
        // AgentSession.
        if (isSessionAuthorityError(error)) {
          return createSessionObserver(id, filePath);
        }
        throw error;
      });
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
