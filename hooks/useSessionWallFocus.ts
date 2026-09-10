"use client";

import { useLayoutEffect, useRef, useState } from "react";

export interface SessionWallFocusIdentity {
  readonly paneId: string;
  readonly sessionId: string;
  readonly runtimeRevision: number;
}

export interface SessionWallFocusToken extends SessionWallFocusIdentity {
  readonly generation: number;
}

function copyIdentity(identity: SessionWallFocusIdentity | null): SessionWallFocusIdentity | null {
  if (!identity || !identity.paneId || !identity.sessionId) return null;
  return Object.freeze({
    paneId: identity.paneId,
    sessionId: identity.sessionId,
    runtimeRevision: identity.runtimeRevision,
  });
}

function sameIdentity(
  left: SessionWallFocusIdentity | null,
  right: SessionWallFocusIdentity | null,
): boolean {
  return Boolean(
    left
    && right
    && left.paneId === right.paneId
    && left.sessionId === right.sessionId
    && left.runtimeRevision === right.runtimeRevision,
  );
}

export interface SessionWallFocusGuard {
  advance(identity: SessionWallFocusIdentity | null): SessionWallFocusToken | null;
  invalidate(): number;
  capture(identity: SessionWallFocusIdentity | null): SessionWallFocusToken | null;
  accept(token: SessionWallFocusToken | null): boolean;
  isCurrent(identity: SessionWallFocusIdentity | null): boolean;
  getCurrent(): SessionWallFocusToken | null;
  getGeneration(): number;
}

export function createSessionWallFocusGuard(): SessionWallFocusGuard {
  let currentIdentity: SessionWallFocusIdentity | null = null;
  let generation = 0;

  const getCurrent = (): SessionWallFocusToken | null => {
    if (!currentIdentity) return null;
    return Object.freeze({
      paneId: currentIdentity.paneId,
      sessionId: currentIdentity.sessionId,
      runtimeRevision: currentIdentity.runtimeRevision,
      generation,
    });
  };

  const advance = (identity: SessionWallFocusIdentity | null): SessionWallFocusToken | null => {
    const nextIdentity = copyIdentity(identity);
    if (!sameIdentity(currentIdentity, nextIdentity)) {
      currentIdentity = nextIdentity;
      generation += 1;
    }
    return getCurrent();
  };

  return {
    advance,
    invalidate: () => {
      currentIdentity = null;
      generation += 1;
      return generation;
    },
    capture: (identity) => {
      const nextIdentity = copyIdentity(identity);
      if (!nextIdentity || !sameIdentity(currentIdentity, nextIdentity)) return null;
      return Object.freeze({
        paneId: nextIdentity.paneId,
        sessionId: nextIdentity.sessionId,
        runtimeRevision: nextIdentity.runtimeRevision,
        generation,
      });
    },
    accept: (token) => Boolean(
      token
      && token.generation === generation
      && sameIdentity(currentIdentity, token),
    ),
    isCurrent: (identity) => sameIdentity(currentIdentity, copyIdentity(identity)),
    getCurrent,
    getGeneration: () => generation,
  };
}

export interface UseSessionWallFocusOptions {
  enabled?: boolean;
  paneId?: string | null;
  sessionId?: string | null;
  runtimeRevision?: number;
}

export function useSessionWallFocus({
  enabled = true,
  paneId = null,
  sessionId = null,
  runtimeRevision = 0,
}: UseSessionWallFocusOptions = {}): SessionWallFocusGuard {
  const guardRef = useRef<SessionWallFocusGuard | null>(null);
  if (!guardRef.current) guardRef.current = createSessionWallFocusGuard();
  const guard = guardRef.current;
  const committedIdentityRef = useRef<SessionWallFocusIdentity | null>(null);
  const lifecycleRef = useRef({ epoch: 0 });
  const [, setSyncVersion] = useState(0);

  useLayoutEffect(() => {
    const nextIdentity = enabled && paneId && sessionId
      ? { paneId, sessionId, runtimeRevision }
      : null;
    const identityChanged = !sameIdentity(committedIdentityRef.current, nextIdentity);
    guard.advance(nextIdentity);
    committedIdentityRef.current = nextIdentity;
    if (identityChanged) setSyncVersion((version) => version + 1);

    const lifecycle = lifecycleRef.current;
    const effectEpoch = ++lifecycle.epoch;
    return () => {
      queueMicrotask(() => {
        if (lifecycle.epoch !== effectEpoch) return;
        guard.invalidate();
        committedIdentityRef.current = null;
      });
    };
  }, [enabled, guard, paneId, runtimeRevision, sessionId]);

  return guard;
}
