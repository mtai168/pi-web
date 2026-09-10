import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createSessionWallToolbarOwnership, createSessionWallToolbarReporterController, getSessionWallToolbarOwnerKey } = await createJiti(import.meta.url, {
  tsconfigPaths: true,
}).import("./toolbar-ownership.ts");

test("committed toolbar reporter tokens fence remounts, focus changes, and pruning", () => {
  const ownership = createSessionWallToolbarOwnership();
  const ownerK = getSessionWallToolbarOwnerKey({ paneId: "pane-a", sessionId: "session-a", runtimeRevision: 1 });
  const ownerL = getSessionWallToolbarOwnerKey({ paneId: "pane-b", sessionId: "session-b", runtimeRevision: 1 });
  assert.ok(ownerK);
  assert.ok(ownerL);

  let stats = "unset";
  let context = "unset";
  const controller = createSessionWallToolbarReporterController({
    acceptsOwner: (ownerKey) => ownership.accepts(ownerKey),
    onSessionStatsChange: (value) => { stats = value?.sessionName ?? (value === null ? "null" : "unknown"); },
    onContextUsageChange: (value) => { context = value?.tokens?.toString() ?? (value === null ? "null" : "unknown"); },
  });

  const abandoned = controller.create(ownerK);
  abandoned.onSessionStatsChange({ sessionName: "abandoned" });
  abandoned.onContextUsageChange({ percent: 1, contextWindow: 100, tokens: 1 });
  assert.equal(controller.size(), 0);
  assert.equal(stats, "unset");
  assert.equal(context, "unset");

  ownership.transition(ownerK);
  const first = controller.create(ownerK);
  first.commit();
  first.onSessionStatsChange({ sessionName: "first" });
  first.onContextUsageChange({ percent: 10, contextWindow: 100, tokens: 10 });

  const second = controller.create(ownerK);
  second.commit();
  first.onSessionStatsChange({ sessionName: "stale" });
  first.onContextUsageChange({ percent: 90, contextWindow: 100, tokens: 90 });
  first.invalidate();
  assert.equal(controller.size(), 1);
  assert.equal(stats, "first");
  assert.equal(context, "10");

  second.onSessionStatsChange({ sessionName: "second" });
  second.onContextUsageChange({ percent: 20, contextWindow: 100, tokens: 20 });
  assert.equal(stats, "second");
  assert.equal(context, "20");
  second.onSessionStatsChange(null);
  second.onContextUsageChange(null);
  assert.equal(stats, "null");
  assert.equal(context, "null");

  ownership.transition(ownerL);
  stats = null;
  context = null;
  second.onSessionStatsChange({ sessionName: "stale-focus" });
  second.onContextUsageChange({ percent: 30, contextWindow: 100, tokens: 30 });
  assert.equal(stats, null);
  assert.equal(context, null);

  const third = controller.create(ownerL);
  third.commit();
  third.onSessionStatsChange({ sessionName: "third" });
  assert.equal(controller.size(), 2);
  controller.prune(new Set([ownerL]));
  assert.equal(controller.size(), 1);
  second.onSessionStatsChange({ sessionName: "removed" });
  assert.equal(stats, "third");
  third.invalidate();
  assert.equal(controller.size(), 0);
});
