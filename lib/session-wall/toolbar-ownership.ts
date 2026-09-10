import type { SessionStatsInfo } from "../pi-types";

export interface SessionWallToolbarOwner {
  paneId: string;
  sessionId: string;
  runtimeRevision: number;
}

export function getSessionWallToolbarOwnerKey(
  owner: SessionWallToolbarOwner | null | undefined,
): string | null {
  if (!owner?.paneId || !owner.sessionId) return null;
  return JSON.stringify([owner.paneId, owner.sessionId, owner.runtimeRevision]);
}

export interface SessionWallToolbarOwnership {
  getCurrent(): string | null;
  transition(nextKey: string | null): boolean;
  accepts(candidateKey: string | null): boolean;
}

export function createSessionWallToolbarOwnership(): SessionWallToolbarOwnership {
  let currentKey: string | null = null;
  return {
    getCurrent: () => currentKey,
    transition(nextKey) {
      if (currentKey === nextKey) return false;
      currentKey = nextKey;
      return true;
    },
    accepts(candidateKey) {
      return candidateKey !== null && candidateKey === currentKey;
    },
  };
}

export interface SessionWallToolbarContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface SessionWallToolbarReporter {
  onSessionStatsChange: (stats: SessionStatsInfo | null) => void;
  onContextUsageChange: (usage: SessionWallToolbarContextUsage | null) => void;
  commit(): void;
  invalidate(): void;
}

export interface SessionWallToolbarReporterController {
  create(ownerKey: string): SessionWallToolbarReporter;
  prune(activeOwnerKeys: ReadonlySet<string>): void;
  size(): number;
}

export function createSessionWallToolbarReporterController({
  acceptsOwner,
  onSessionStatsChange,
  onContextUsageChange,
}: {
  acceptsOwner: (ownerKey: string) => boolean;
  onSessionStatsChange: (stats: SessionStatsInfo | null) => void;
  onContextUsageChange: (usage: SessionWallToolbarContextUsage | null) => void;
}): SessionWallToolbarReporterController {
  const currentTokens = new Map<string, object>();

  return {
    create(ownerKey) {
      let token: object | null = null;
      const isCurrent = () => token !== null && currentTokens.get(ownerKey) === token;
      return {
        onSessionStatsChange(stats) {
          if (isCurrent() && acceptsOwner(ownerKey)) onSessionStatsChange(stats);
        },
        onContextUsageChange(usage) {
          if (isCurrent() && acceptsOwner(ownerKey)) onContextUsageChange(usage);
        },
        commit() {
          if (token !== null) return;
          token = {};
          currentTokens.set(ownerKey, token);
        },
        invalidate() {
          const committedToken = token;
          token = null;
          if (committedToken !== null && currentTokens.get(ownerKey) === committedToken) {
            currentTokens.delete(ownerKey);
          }
        },
      };
    },
    prune(activeOwnerKeys) {
      for (const ownerKey of currentTokens.keys()) {
        if (!activeOwnerKeys.has(ownerKey)) currentTokens.delete(ownerKey);
      }
    },
    size: () => currentTokens.size,
  };
}
