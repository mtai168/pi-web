import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { delegateExternalOwnerRequest, forwardExternalOwnerResponse, isDelegatedRequest, isExternalOwnerMode } from "@/lib/external-owner";
import { authorityErrorMessage, isSessionAuthorityError } from "@/lib/session-authority";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(req: Request) {
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
    // Running state is sourced from the sole authority; the local registry
    // is always empty in external-owner mode.
    try {
      const upstream = await delegateExternalOwnerRequest(
        "/api/agent/running",
        { signal: req.signal },
      );
      const forwarded = forwardExternalOwnerResponse(upstream);
      // The standalone path sends no-store; keep that contract so polling
      // never serves stale running state from a cache.
      forwarded.headers.set("Cache-Control", "no-store");
      return forwarded;
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
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
