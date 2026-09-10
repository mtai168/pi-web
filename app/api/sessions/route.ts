import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    // Capture after the awaited scan: the version must be at least the
    // generation of the returned data, so a mutation during the scan still
    // forces a client refresh instead of being masked by a stale version.
    const sessionListVersion = getSessionListVersion();
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return NextResponse.json(
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
