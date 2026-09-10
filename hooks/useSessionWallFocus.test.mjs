import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * These are pure/source-contract tests. No approved client renderer is available
 * here, so they do not prove concurrent scheduling or effect cleanup behavior.
 */
const hookSource = await readFile(new URL("./useSessionWallFocus.ts", import.meta.url), "utf8");
const { createSessionWallFocusGuard } = await import("./useSessionWallFocus.ts");

const identity = (paneId, sessionId, runtimeRevision = 0) => ({
  paneId,
  sessionId,
  runtimeRevision,
});

test("accepts only the current immutable pane/session token", () => {
  const guard = createSessionWallFocusGuard();
  const source = identity("pane-a", "session-a", 2);
  const current = guard.advance(source);
  const captured = guard.capture(source);

  assert.ok(current);
  assert.ok(captured);
  assert.equal(captured.generation, current.generation);
  assert.equal(guard.accept(captured), true);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(current), true);

  source.sessionId = "session-mutated";
  assert.equal(captured.sessionId, "session-a");
  assert.equal(guard.accept(captured), true);
});

test("rejects a slow callback from pane A after pane B is focused", () => {
  const guard = createSessionWallFocusGuard();
  const tokenA = guard.advance(identity("pane-a", "session-a"));
  const slowA = guard.capture(identity("pane-a", "session-a"));
  const tokenB = guard.advance(identity("pane-b", "session-b"));
  const currentB = guard.capture(identity("pane-b", "session-b"));

  assert.ok(tokenA);
  assert.ok(tokenB);
  assert.ok(slowA);
  assert.ok(currentB);
  assert.notEqual(tokenA.generation, tokenB.generation);
  assert.equal(guard.accept(slowA), false);
  assert.equal(guard.accept(currentB), true);
  assert.equal(guard.isCurrent(identity("pane-a", "session-a")), false);
  assert.equal(guard.isCurrent(identity("pane-b", "session-b")), true);
});

test("replacement advances generation even when pane and session ids are unchanged", () => {
  const guard = createSessionWallFocusGuard();
  const oldToken = guard.advance(identity("pane-a", "session-a", 1));
  const replacement = guard.advance(identity("pane-a", "session-a", 2));
  const replacementToken = guard.capture(identity("pane-a", "session-a", 2));

  assert.ok(oldToken);
  assert.ok(replacement);
  assert.ok(replacementToken);
  assert.notEqual(oldToken.generation, replacement.generation);
  assert.equal(guard.accept(oldToken), false);
  assert.equal(guard.accept(replacementToken), true);
});

// The client hook uses this explicit invalidation for lifecycle and mode changes;
// this test deliberately exercises the pure guard without mounting React.
test("invalidate clears the bridge and gates no-focus callbacks", () => {
  const guard = createSessionWallFocusGuard();
  const token = guard.advance(identity("pane-a", "session-a"));
  assert.ok(token);

  const generation = guard.invalidate();
  assert.equal(guard.getCurrent(), null);
  assert.equal(guard.getGeneration(), generation);
  assert.equal(guard.accept(token), false);
  assert.equal(guard.capture(identity("pane-a", "session-a")), null);
  assert.equal(guard.isCurrent(identity("pane-a", "session-a")), false);
});

test("keeps hook identity mutation in the commit phase", () => {
  const hookStart = hookSource.indexOf("export function useSessionWallFocus");
  const effectStart = hookSource.indexOf("useLayoutEffect(() =>", hookStart);
  assert.ok(hookStart >= 0);
  assert.ok(effectStart > hookStart);
  assert.doesNotMatch(hookSource.slice(hookStart, effectStart), /guard\.(advance|invalidate)\s*\(/);
  assert.match(hookSource.slice(effectStart), /guard\.advance\(nextIdentity\)/);
  assert.match(hookSource.slice(effectStart), /setSyncVersion/);
  assert.match(hookSource.slice(effectStart), /const lifecycle = lifecycleRef\.current/);
  assert.match(hookSource.slice(effectStart), /lifecycle\.epoch !== effectEpoch/);
  assert.match(hookSource.slice(effectStart), /queueMicrotask/);
});

test("keeps the committed token while a new render identity is uncommitted", () => {
  const guard = createSessionWallFocusGuard();
  const committedA = guard.advance(identity("pane-a", "session-a", 1));
  const renderB = identity("pane-b", "session-b", 2);

  assert.ok(committedA);
  assert.equal(guard.capture(renderB), null);
  assert.equal(guard.accept(committedA), true);

  const committedB = guard.advance(renderB);
  const currentB = guard.capture(renderB);
  assert.ok(committedB);
  assert.ok(currentB);
  assert.equal(guard.accept(committedA), false);
  assert.equal(guard.accept(currentB), true);
});
