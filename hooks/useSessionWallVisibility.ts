"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefCallback } from "react";
import {
  getSessionWallRuntimeIdentityKey,
  getSessionWallRuntimePolicy,
  type SessionWallRuntimeIdentity,
  type SessionWallRuntimePolicy,
  type SessionWallRuntimeTier,
} from "@/lib/session-wall/runtime-policy";
import { countSessionWallTierTransition } from "@/lib/session-wall/diagnostics";
import type { SessionWallLayout } from "@/lib/session-wall/types";

export interface UseSessionWallVisibilityOptions {
  readonly runtime: SessionWallRuntimeIdentity;
  readonly layout: SessionWallLayout;
  readonly inOverscan: boolean;
  readonly focused: boolean;
  readonly blockingAttention: boolean;
}

interface ObservationState {
  runtimeKey: string;
  targetVersion: number;
  visible: boolean;
  observed: boolean;
}

export interface UseSessionWallVisibilityResult {
  readonly ref: RefCallback<HTMLElement>;
  readonly runtimeKey: string;
  readonly visible: boolean;
  readonly inOverscan: boolean;
  readonly observed: boolean;
  readonly tier: SessionWallRuntimeTier;
  readonly policy: SessionWallRuntimePolicy;
}

function unknownObservation(runtimeKey: string, targetVersion: number): ObservationState {
  return { runtimeKey, targetVersion, visible: false, observed: false };
}

export function useSessionWallVisibility({
  runtime,
  layout,
  inOverscan,
  focused,
  blockingAttention,
}: UseSessionWallVisibilityOptions): UseSessionWallVisibilityResult {
  const runtimeKey = getSessionWallRuntimeIdentityKey(runtime);
  const activeRuntimeKeyRef = useRef<string | null>(runtimeKey);
  useLayoutEffect(() => {
    activeRuntimeKeyRef.current = runtimeKey; return () => { if (activeRuntimeKeyRef.current === runtimeKey) activeRuntimeKeyRef.current = null; };
  }, [runtimeKey]);
  const [observation, setObservation] = useState(() => unknownObservation(runtimeKey, 0));
  const targetRef = useRef<HTMLElement | null>(null);
  const targetVersionRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback<RefCallback<HTMLElement>>((node) => {
    if (targetRef.current === node) return;
    const observer = observerRef.current;
    if (targetRef.current && observer) observer.unobserve(targetRef.current);
    targetRef.current = node;
    const targetVersion = targetVersionRef.current + 1;
    targetVersionRef.current = targetVersion;
    const activeRuntimeKey = activeRuntimeKeyRef.current;
    if (activeRuntimeKey) setObservation(unknownObservation(activeRuntimeKey, targetVersion));
    if (node && observer) observer.observe(node);
  }, []);

  useEffect(() => {
    const identityKey = runtimeKey;
    let active = true;
    setObservation(unknownObservation(identityKey, targetVersionRef.current));
    if (typeof IntersectionObserver === "undefined") return () => { active = false; };

    const observer = new IntersectionObserver((entries) => {
      const target = targetRef.current;
      const targetVersion = targetVersionRef.current;
      const entry = entries.find((candidate) => candidate.target === target);
      if (!target || !entry || !active || activeRuntimeKeyRef.current !== identityKey) return;
      setObservation((current) => {
        if (current.runtimeKey !== identityKey
          || current.targetVersion !== targetVersion
          || targetVersionRef.current !== targetVersion
          || activeRuntimeKeyRef.current !== identityKey) return current;
        return { runtimeKey: identityKey, targetVersion, visible: entry.isIntersecting, observed: true };
      });
    });
    observerRef.current = observer;
    if (targetRef.current) observer.observe(targetRef.current);

    return () => {
      active = false;
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [runtimeKey]);

  const current = observation.runtimeKey === runtimeKey && observation.targetVersion === targetVersionRef.current
    ? observation
    : unknownObservation(runtimeKey, targetVersionRef.current);
  const policy = getSessionWallRuntimePolicy({
    runtime,
    layout,
    visible: current.visible,
    inOverscan,
    focused,
    blockingAttention,
    observed: current.observed,
  });
  const tier = policy.tier;
  const previousTierRef = useRef<SessionWallRuntimeTier | null>(null);
  useEffect(() => {
    if (previousTierRef.current !== tier) {
      previousTierRef.current = tier;
      countSessionWallTierTransition(tier);
    }
  }, [tier]);

  return {
    ref,
    runtimeKey,
    visible: current.visible,
    inOverscan,
    observed: current.observed,
    tier,
    policy,
  };
}
