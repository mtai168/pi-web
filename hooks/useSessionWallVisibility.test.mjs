import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./useSessionWallVisibility.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSessionWallRuntimeIdentityKey } = await jiti.import("../lib/session-wall/runtime-policy.ts");
const runtime = { paneId: "pane-1", sessionId: "session-1", runtimeRevision: 0 };

test("uses stable identity values and changes keys for replacement runtimes", () => {
  assert.equal(getSessionWallRuntimeIdentityKey(runtime), getSessionWallRuntimeIdentityKey({ ...runtime }));
  assert.notEqual(getSessionWallRuntimeIdentityKey(runtime), getSessionWallRuntimeIdentityKey({ ...runtime, runtimeRevision: 1 }));
  assert.notEqual(getSessionWallRuntimeIdentityKey(runtime), getSessionWallRuntimeIdentityKey({ ...runtime, sessionId: "session-2" }));
});
test("defines conservative SSR and no-observer behavior", () => {
  assert.match(source, /typeof IntersectionObserver === "undefined"/);
  assert.match(source, /visible: false, observed: false/);
  assert.match(source, /observed: current\.observed/);
});
test("guards replacement callbacks, resets detached targets, and disconnects the observation", () => {
  assert.match(source, /activeRuntimeKeyRef\.current = runtimeKey/);
  assert.match(source, /activeRuntimeKeyRef\.current !== identityKey/);
  assert.match(source, /current\.runtimeKey !== identityKey/);
  assert.match(source, /targetVersionRef/);
  assert.match(source, /targetRef\.current === node/);
  assert.match(source, /const activeRuntimeKey = activeRuntimeKeyRef\.current/);
  assert.match(source, /setObservation\(unknownObservation\(activeRuntimeKey, targetVersion\)\)/);
  assert.match(source, /observation\.targetVersion === targetVersionRef\.current/);
  assert.match(source, /current\.targetVersion !== targetVersion/);
  assert.match(source, /targetVersionRef\.current !== targetVersion/);
  assert.match(source, /observer\.disconnect\(\)/);
  assert.match(source, /observer\.unobserve\(targetRef\.current\)/);
  assert.match(source, /candidate\.target === target/);
});
test("keeps the ref stable and does not churn observers for flags", () => {
  assert.match(source, /useCallback<RefCallback<HTMLElement>>\([\s\S]*?\}, \[\]\)/);
  assert.match(source, /\}, \[runtimeKey\]\);/);
  assert.doesNotMatch(source, /fetch\(|EventSource|setInterval|setTimeout|localStorage|globalThis/);
  assert.match(source, /inOverscan,\n    focused,\n    blockingAttention,/);
});

test("counts each tier transition once at the policy boundary", () => {
  assert.match(source, /countSessionWallTierTransition/);
  assert.match(source, /previousTierRef\.current !== tier/);
  assert.match(source, /\}, \[tier\]\);/);
  assert.equal((source.match(/countSessionWallTierTransition\(tier\)/g) ?? []).length, 1);
});
