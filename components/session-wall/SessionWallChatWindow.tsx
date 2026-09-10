"use client";

import { useLayoutEffect, useMemo, type ComponentProps } from "react";
import type { SessionWallToolbarReporterController } from "@/lib/session-wall/toolbar-ownership";
import { ChatWindow } from "../ChatWindow";

type ChatWindowProps = ComponentProps<typeof ChatWindow>;

export type SessionWallChatWindowProps = Omit<ChatWindowProps, "onSessionStatsChange" | "onContextUsageChange" | "wallModeActive" | "toolbarReportingActive"> & {
  toolbarOwnerKey: string;
  toolbarReporterController: SessionWallToolbarReporterController;
  wallModeActive: boolean;
  toolbarReportingActive: boolean;
};

export function SessionWallChatWindow({
  toolbarOwnerKey,
  toolbarReporterController,
  wallModeActive,
  toolbarReportingActive,
  ...chatWindowProps
}: SessionWallChatWindowProps) {
  const reporter = useMemo(
    () => toolbarReporterController.create(toolbarOwnerKey),
    [toolbarOwnerKey, toolbarReporterController],
  );

  useLayoutEffect(() => {
    if (!wallModeActive) {
      reporter.invalidate();
      return;
    }
    reporter.commit();
    return () => reporter.invalidate();
  }, [reporter, wallModeActive]);

  return (
    <ChatWindow
      {...chatWindowProps}
      wallModeActive={wallModeActive}
      toolbarReportingActive={toolbarReportingActive}
      onSessionStatsChange={reporter.onSessionStatsChange}
      onContextUsageChange={reporter.onContextUsageChange}
    />
  );
}
