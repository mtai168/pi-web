import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const diagnostics = await jiti.import("./diagnostics.ts");

const ZERO = {
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

test("reset clears every counter and the snapshot is finite and JSON-safe", () => {
  diagnostics.resetSessionWallDiagnostics();
  const snapshot = diagnostics.getSessionWallDiagnostics();
  assert.deepEqual(snapshot, ZERO);
  const json = JSON.stringify(snapshot);
  assert.equal(typeof json, "string");
  assert.doesNotMatch(json, /session|path|prompt|message|model|error/i);
});

test("increments all four required categories without retaining payloads", () => {
  diagnostics.resetSessionWallDiagnostics();
  diagnostics.countSessionWallTierTransition("hot");
  diagnostics.countSessionWallTierTransition("warm");
  diagnostics.countSessionWallTierTransition("cold");
  diagnostics.countSessionWallTierTransition("hot");
  diagnostics.bumpSessionWallDiagnostic("paneMounts");
  diagnostics.bumpSessionWallDiagnostic("paneUnmounts");
  diagnostics.bumpSessionWallDiagnostic("runtimeMounts");
  diagnostics.bumpSessionWallDiagnostic("runtimeUnmounts");
  diagnostics.bumpSessionWallDiagnostic("sseOpens");
  diagnostics.bumpSessionWallDiagnostic("sseCloses");
  diagnostics.bumpSessionWallDiagnostic("sseRetries");
  diagnostics.bumpSessionWallDiagnostic("agentRequests");
  const snapshot = diagnostics.getSessionWallDiagnostics();
  assert.deepEqual(snapshot, {
    tierTransitions: { hot: 2, warm: 1, cold: 1 },
    paneMounts: 1,
    paneUnmounts: 1,
    runtimeMounts: 1,
    runtimeUnmounts: 1,
    sseOpens: 1,
    sseCloses: 1,
    sseRetries: 1,
    agentRequests: 1,
  });
  for (const value of Object.values(snapshot)) {
    const values = typeof value === "object" ? Object.values(value) : [value];
    for (const nested of values) assert.equal(typeof nested, "number");
  }
});

test("snapshot copies do not share state with the counters", () => {
  diagnostics.resetSessionWallDiagnostics();
  const before = diagnostics.getSessionWallDiagnostics();
  diagnostics.bumpSessionWallDiagnostic("agentRequests");
  assert.equal(before.agentRequests, 0);
  assert.equal(diagnostics.getSessionWallDiagnostics().agentRequests, 1);
});

test("production guard makes increments and snapshots no-ops", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const prodJiti = createJiti(import.meta.url, { moduleCache: false });
    const prod = await prodJiti.import("./diagnostics.ts");
    prod.countSessionWallTierTransition("hot");
    prod.bumpSessionWallDiagnostic("sseOpens");
    prod.bumpSessionWallDiagnostic("agentRequests");
    assert.deepEqual(prod.getSessionWallDiagnostics(), ZERO);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
