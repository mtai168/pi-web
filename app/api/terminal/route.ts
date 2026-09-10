import { realpath, stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { createTerminal } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TERMINAL_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-f0-9]{32})$/;

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { id?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown } | null;
    if (body === null || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    if (body.id !== undefined && (typeof body.id !== "string" || !TERMINAL_ID_PATTERN.test(body.id))) {
      return NextResponse.json({ error: "Invalid terminal id" }, { status: 400 });
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    // Resolve symlinks once and spawn from the canonical path so a concurrent
    // symlink swap cannot redirect the shell outside the authorized roots.
    let realCwd: string;
    try {
      realCwd = await realpath(resolve(body.cwd));
      if (!(await stat(realCwd)).isDirectory()) {
        return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
    }
    const roots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(realCwd, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const id = createTerminal(
      realCwd,
      typeof body.cols === "number" ? body.cols : 80,
      typeof body.rows === "number" ? body.rows : 24,
      body.id as string | undefined,
    );
    return NextResponse.json({ id });
  } catch (error) {
    console.error("[pi-web] terminal create failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to create terminal" }, { status: 500 });
  }
}
