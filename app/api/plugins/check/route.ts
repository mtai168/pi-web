import { NextResponse } from "next/server";
import { realpathSync, statSync } from "fs";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PluginScope } from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { checkPluginUpdates } from "@/lib/plugin-updates";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { cwd?: unknown; source?: unknown; scope?: unknown };
  try {
    body = (await req.json() ?? {}) as { cwd?: unknown; source?: unknown; scope?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    // Canonicalize once and authorize that canonical result, so the directory
    // check and the path the request is approved for are the same path.
    let resolvedCwd: string;
    try {
      resolvedCwd = realpathSync(cwd);
    } catch {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(resolvedCwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    try {
      if (!statSync(resolvedCwd).isDirectory()) {
        return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
    }

    const source = typeof body.source === "string" ? body.source : undefined;
    const scope = body.scope === "global" || body.scope === "project"
      ? body.scope as PluginScope
      : undefined;
    if ((source && !scope) || (!source && scope)) {
      return NextResponse.json({ error: "source and scope must be provided together" }, { status: 400 });
    }

    // Untrusted projects must not induce network checks against their own
    // configured project packages (mirrors the plugin mutation route). The
    // canonical real path is the project identity: every downstream trust,
    // settings, package-manager, and update-check operation uses resolvedCwd,
    // so a path authorized by realpath is the path those operations act on,
    // and a legacy lexical/symlink trust entry fails closed instead of being
    // silently migrated or widened.
    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(resolvedCwd, agentDir);
    const settingsManager = SettingsManager.create(resolvedCwd, agentDir, {
      projectTrusted: projectTrust.trusted,
    });
    const packageManager = new DefaultPackageManager({ cwd: resolvedCwd, agentDir, settingsManager });
    const wouldCheckProjectPackages = !source || scope === "project";
    if (!projectTrust.trusted && wouldCheckProjectPackages
      && packageManager.listConfiguredPackages().some((pkg) => pkg.scope === "project")) {
      return NextResponse.json(
        { error: "Project resources must be trusted before checking project plugins" },
        { status: 403 },
      );
    }

    const updates = await checkPluginUpdates(resolvedCwd, source && scope ? { source, scope } : undefined);
    if (source && scope && updates.length === 0) {
      return NextResponse.json({ error: "Configured package not found" }, { status: 404 });
    }

    return NextResponse.json({ updates });
  } catch (error) {
    console.error("[pi-web] plugin check failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Plugin check failed" }, { status: 500 });
  }
}
