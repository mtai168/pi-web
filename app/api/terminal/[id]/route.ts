import { NextResponse } from "next/server";
import { getTerminalCwd, killTerminal, resizeTerminal, writeTerminal } from "@/lib/terminal-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  const { id } = await params;
  const cwd = getTerminalCwd(id);
  return cwd
    ? NextResponse.json({ id, cwd })
    : NextResponse.json({ error: "Terminal expired or closed" }, { status: 404 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const { id } = await params;
    const body = await req.json() as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown } | null;
    if (body === null || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid terminal command" }, { status: 400 });
    }
    if (body.type === "input" && typeof body.data === "string" && body.data.length <= 64 * 1024) {
      return writeTerminal(id, body.data)
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    if (body.type === "resize" && Number.isInteger(body.cols) && Number.isInteger(body.rows)
      && (body.cols as number) >= 2 && (body.cols as number) <= 1000
      && (body.rows as number) >= 2 && (body.rows as number) <= 1000) {
      return resizeTerminal(id, body.cols as number, body.rows as number)
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Invalid terminal command" }, { status: 400 });
  } catch (error) {
    console.error("[pi-web] terminal command failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Terminal command failed" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  const { id } = await params;
  killTerminal(id);
  return NextResponse.json({ success: true });
}
