import {
  SESSION_WALL_LAYOUTS,
  type SessionWallLayout,
  type SessionWallPaneConfig,
} from "./types";
export type SessionWallRuntimeTier = "hot" | "warm" | "cold";
export type SessionWallRuntimeReason =
  | "visible"
  | "focused"
  | "blocking-attention"
  | "unknown-visibility"
  | "two-by-two-fail-open"
  | "overscan"
  | "outside-overscan"
  | "invalid-input";
export type SessionWallRuntimeIdentity = Readonly<Pick<
  SessionWallPaneConfig,
  "paneId" | "sessionId" | "runtimeRevision"
>>;
export interface SessionWallRuntimePolicyInput {
  readonly layout: SessionWallLayout;
  readonly runtime: SessionWallRuntimeIdentity;
  readonly visible: boolean;
  readonly inOverscan: boolean;
  readonly focused: boolean;
  readonly blockingAttention: boolean;
  readonly observed: boolean;
}
export interface SessionWallRuntimePolicy {
  readonly tier: SessionWallRuntimeTier;
  readonly reason: SessionWallRuntimeReason;
}

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export function isSessionWallRuntimeIdentity(value: unknown): value is SessionWallRuntimeIdentity {
  if (!isRecord(value)
    || !isCanonicalText(value.paneId)
    || (value.sessionId !== null && !isCanonicalText(value.sessionId))
    || (value.runtimeRevision !== undefined
      && (typeof value.runtimeRevision !== "number"
        || !Number.isSafeInteger(value.runtimeRevision) || value.runtimeRevision < 0))) {
    return false;
  }
  return "sessionId" in value;
}

export function getSessionWallRuntimeIdentityKey(runtime: SessionWallRuntimeIdentity): string {
  if (!isSessionWallRuntimeIdentity(runtime)) return "invalid";
  return JSON.stringify([runtime.paneId, runtime.sessionId, runtime.runtimeRevision ?? 0]);
}

function isSessionWallRuntimePolicyInput(value: unknown): value is SessionWallRuntimePolicyInput {
  return isRecord(value)
    && SESSION_WALL_LAYOUTS.includes(value.layout as SessionWallLayout)
    && isSessionWallRuntimeIdentity(value.runtime)
    && typeof value.visible === "boolean"
    && typeof value.inOverscan === "boolean"
    && typeof value.focused === "boolean"
    && typeof value.blockingAttention === "boolean"
    && typeof value.observed === "boolean";
}

function decision(tier: SessionWallRuntimeTier, reason: SessionWallRuntimeReason): SessionWallRuntimePolicy {
  return { tier, reason };
}

export function getSessionWallRuntimePolicy(input: SessionWallRuntimePolicyInput): SessionWallRuntimePolicy {
  if (!isSessionWallRuntimePolicyInput(input)) return decision("warm", "invalid-input");
  if (input.visible) return decision("hot", "visible");
  if (input.focused) return decision("hot", "focused");
  if (input.blockingAttention) return decision("hot", "blocking-attention");
  if (!input.observed) return decision("warm", "unknown-visibility");
  if (input.layout === "2x2") return decision("warm", "two-by-two-fail-open");
  if (input.inOverscan) return decision("warm", "overscan");
  return decision("cold", "outside-overscan");
}
