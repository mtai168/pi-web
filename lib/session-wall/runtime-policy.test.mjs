import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./runtime-policy.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { getSessionWallRuntimePolicy } = await jiti.import("./runtime-policy.ts");

const runtime = { paneId: "pane-1", sessionId: "session-1", runtimeRevision: 2 };
const input = (overrides = {}) => ({ layout: "2x4", runtime, visible: false, inOverscan: false, focused: false, blockingAttention: false, observed: true, ...overrides });

test("classifies visible, overscan, cold, and 2x2 panes", () => {
  for (const overrides of [
    { visible: true },
    { inOverscan: true },
    {},
    { layout: "2x2" },
  ]) {
    const expected = overrides.visible
      ? { tier: "hot", reason: "visible" }
      : overrides.inOverscan
        ? { tier: "warm", reason: "overscan" }
        : overrides.layout === "2x2"
          ? { tier: "warm", reason: "two-by-two-fail-open" }
          : { tier: "cold", reason: "outside-overscan" };
    assert.deepEqual(getSessionWallRuntimePolicy(input(overrides)), expected);
  }
  assert.deepEqual(getSessionWallRuntimePolicy(input({ layout: "2x2", observed: false })), { tier: "warm", reason: "unknown-visibility" });
});
test("focused and blocking-attention panes stay hot outside the viewport", () => {
  for (const field of ["focused", "blockingAttention"]) assert.equal(getSessionWallRuntimePolicy(input({ [field]: true })).tier, "hot");
});
test("invalid or incomplete visibility input fails open", () => {
  for (const value of [null, input({ layout: "2x8" }), input({ visible: undefined }), input({ runtime: null }), input({ observed: false })]) {
    assert.notEqual(getSessionWallRuntimePolicy(value).tier, "cold");
  }
});
test("does not mutate input or depend on runtime side effects", () => {
  const value = input();
  const before = structuredClone(value);
  getSessionWallRuntimePolicy(value);
  assert.deepEqual(value, before);
  assert.doesNotMatch(source, /React|window|document|fetch\(|EventSource|setTimeout|setInterval|localStorage/);
  assert.doesNotMatch(source, /transcript|running|Brain/);
});
