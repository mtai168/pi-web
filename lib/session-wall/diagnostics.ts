import type { SessionWallRuntimeTier } from "./runtime-policy";

export interface SessionWallDiagnosticsSnapshot {
  readonly tierTransitions: Readonly<Record<SessionWallRuntimeTier, number>>;
  readonly paneMounts: number;
  readonly paneUnmounts: number;
  readonly runtimeMounts: number;
  readonly runtimeUnmounts: number;
  readonly sseOpens: number;
  readonly sseCloses: number;
  readonly sseRetries: number;
  readonly agentRequests: number;
}

export type SessionWallDiagnosticCounter =
  | "paneMounts"
  | "paneUnmounts"
  | "runtimeMounts"
  | "runtimeUnmounts"
  | "sseOpens"
  | "sseCloses"
  | "sseRetries"
  | "agentRequests";

function diagnosticsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

const counters = {
  tierTransitions: { hot: 0, warm: 0, cold: 0 },
  paneMounts: 0,
  paneUnmounts: 0,
  runtimeMounts: 0,
  runtimeUnmounts: 0,
  sseOpens: 0,
  sseCloses: 0,
  sseRetries: 0,
  agentRequests: 0,
};

const EMPTY_SNAPSHOT: SessionWallDiagnosticsSnapshot = Object.freeze({
  tierTransitions: Object.freeze({ hot: 0, warm: 0, cold: 0 }),
  paneMounts: 0,
  paneUnmounts: 0,
  runtimeMounts: 0,
  runtimeUnmounts: 0,
  sseOpens: 0,
  sseCloses: 0,
  sseRetries: 0,
  agentRequests: 0,
});

export function resetSessionWallDiagnostics(): void {
  if (!diagnosticsEnabled()) return;
  counters.tierTransitions.hot = 0;
  counters.tierTransitions.warm = 0;
  counters.tierTransitions.cold = 0;
  counters.paneMounts = 0;
  counters.paneUnmounts = 0;
  counters.runtimeMounts = 0;
  counters.runtimeUnmounts = 0;
  counters.sseOpens = 0;
  counters.sseCloses = 0;
  counters.sseRetries = 0;
  counters.agentRequests = 0;
}

export function getSessionWallDiagnostics(): SessionWallDiagnosticsSnapshot {
  if (!diagnosticsEnabled()) return EMPTY_SNAPSHOT;
  return {
    tierTransitions: { ...counters.tierTransitions },
    paneMounts: counters.paneMounts,
    paneUnmounts: counters.paneUnmounts,
    runtimeMounts: counters.runtimeMounts,
    runtimeUnmounts: counters.runtimeUnmounts,
    sseOpens: counters.sseOpens,
    sseCloses: counters.sseCloses,
    sseRetries: counters.sseRetries,
    agentRequests: counters.agentRequests,
  };
}

export function countSessionWallTierTransition(tier: SessionWallRuntimeTier): void {
  if (!diagnosticsEnabled()) return;
  counters.tierTransitions[tier] += 1;
}

export function bumpSessionWallDiagnostic(counter: SessionWallDiagnosticCounter): void {
  if (!diagnosticsEnabled()) return;
  counters[counter] += 1;
}
