import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same catalog used by the sidebar.
    const sessions = query && !request.signal.aborted ? await listAllSessions() : [];
    return NextResponse.json(await searchSessionContents(sessions, query, request.signal), { headers });
  } catch (error) {
    console.error("[pi-web] session search failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Session search failed" }, { status: 500, headers });
  }
}
