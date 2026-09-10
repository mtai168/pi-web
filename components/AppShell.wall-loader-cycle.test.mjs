import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

/*
 * Behavioral coverage for the Wall system-info loader update cycle, executed
 * against the production controller in lib/session-wall/system-info-loader.ts
 * that AppShell wires for registration, removal, guarded toggle start, and
 * stale completion. Narrow source assertions pin the AppShell wiring.
 */
const jiti = createJiti(import.meta.url);
const { createSystemInfoLoaderController } = await jiti.import("../lib/session-wall/system-info-loader.ts");
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("same-loader re-reports and cleanup churn never re-register", () => {
  const controller = createSystemInfoLoaderController();
  const loaderA = async () => {};
  // Register, then same-reference re-report (focused pane re-render): no-op.
  assert.equal(controller.register(loaderA), true);
  assert.equal(controller.register(loaderA), false);
  assert.equal(controller.current, loaderA);
  // Effect cleanup churn reports null while a loader is registered: no-op.
  assert.equal(controller.register(null), false);
  assert.equal(controller.current, loaderA);
  // A null report with nothing registered is also a no-op.
  const fresh = createSystemInfoLoaderController();
  assert.equal(fresh.register(null), false);
  assert.equal(fresh.current, null);
});

test("a genuinely new loader (focus change, mount) always registers", () => {
  const controller = createSystemInfoLoaderController();
  const loaderA = async () => {};
  const loaderB = async () => {};
  assert.equal(controller.register(loaderA), true);
  assert.equal(controller.register(loaderB), true);
  assert.equal(controller.current, loaderB);
});

test("same-owner rerender cannot invalidate an in-flight load", async () => {
  let release;
  const controller = createSystemInfoLoaderController();
  const loaderA = async () => { await new Promise((r) => { release = r; }); };
  controller.register(loaderA);
  const started = controller.start(true);
  assert.ok(started);
  assert.equal(controller.loading, true);
  // Same-reference re-report while in flight: no-op, the load stays valid.
  assert.equal(controller.register(loaderA), false);
  const pending = started.load();
  release();
  await pending;
  assert.equal(controller.complete(started.loadId), true);
  assert.equal(controller.loading, false);
});

test("replacement invalidates the old generation and installs only the new loader", async () => {
  const invoked = [];
  const controller = createSystemInfoLoaderController();
  const loaderA = async () => { invoked.push("A"); };
  const loaderB = async () => { invoked.push("B"); };
  controller.register(loaderA);
  const stale = controller.start(true);
  assert.ok(stale);
  // Focused-pane replacement: the new loader registers and supersedes the old.
  assert.equal(controller.register(loaderB), true);
  assert.equal(controller.current, loaderB);
  assert.equal(controller.loading, false);
  const current = controller.start(true);
  assert.ok(current);
  // The stale completion must not clear the fresh load's loading state.
  await stale.load();
  assert.equal(controller.complete(stale.loadId), false);
  assert.equal(controller.loading, true);
  await current.load();
  assert.equal(controller.complete(current.loadId), true);
  assert.equal(controller.loading, false);
  // Only the current loader is ever invoked.
  assert.deepEqual(invoked, ["A", "B"]);
});

test("genuine removal unregisters the owner; stale cleanup cannot clear the current loader", async () => {
  const invoked = [];
  const controller = createSystemInfoLoaderController();
  const loaderA = async () => { invoked.push("A"); };
  const loaderB = async () => { invoked.push("B"); };
  controller.register(loaderA);
  const stale = controller.start(true);
  assert.ok(stale);
  // Genuine unregister/removal (clearWallToolbarState / ready-state effect).
  assert.equal(controller.clear(), true);
  assert.equal(controller.current, null);
  assert.equal(controller.loading, false);
  // After removal a toggle is a no-op: the stale loader cannot be invoked.
  assert.equal(controller.start(true), null);
  assert.deepEqual(invoked, []);
  // Clearing again is a no-op.
  assert.equal(controller.clear(), false);
  // A new owner registers and runs; the old owner's completion stays stale.
  assert.equal(controller.register(loaderB), true);
  const current = controller.start(true);
  assert.ok(current);
  await stale.load();
  assert.equal(controller.complete(stale.loadId), false);
  assert.equal(controller.loading, true);
  await current.load();
  assert.equal(controller.complete(current.loadId), true);
  assert.equal(controller.loading, false);
  assert.deepEqual(invoked, ["A", "B"]);
});

test("opening=false, missing loader, and already-loading never start a run", async () => {
  const invoked = [];
  const controller = createSystemInfoLoaderController();
  // No loader registered: a toggle is a no-op.
  assert.equal(controller.start(true), null);
  const loaderA = async () => { invoked.push("A"); };
  controller.register(loaderA);
  // Closing the panel (opening=false) never starts a run.
  assert.equal(controller.start(false), null);
  assert.deepEqual(invoked, []);
  const started = controller.start(true);
  assert.ok(started);
  assert.equal(controller.loading, true);
  // An in-flight load never starts a second run, opening or not.
  assert.equal(controller.start(true), null);
  assert.equal(controller.start(false), null);
  await started.load();
  assert.equal(controller.complete(started.loadId), true);
  assert.equal(controller.loading, false);
  assert.deepEqual(invoked, ["A"]);
});

test("AppShell wires the production controller for registration, removal, and guarded starts", () => {
  assert.match(source, /import \{ createSystemInfoLoaderController, type SystemInfoLoader, type SystemInfoLoaderController \} from "@\/lib\/session-wall\/system-info-loader"/);
  assert.match(source, /systemInfoLoaderControllerRef\.current\?\.register\(loader\)/);
  assert.match(source, /systemInfoLoaderControllerRef\.current\?\.clear\(\)/);
  // Both toggle handlers (normal and wall) start through the controller and
  // hand the run's abort signal to the loader.
  assert.match(source, /if \(workspaceMode === "wall"\) return;[\s\S]{0,160}systemInfoLoaderControllerRef\.current\?\.start\(opening\)/);
  assert.match(source, /if \(!toolbarSession\) return;[\s\S]{0,160}systemInfoLoaderControllerRef\.current\?\.start\(opening\)/);
  assert.match(source, /started\.load\(started\.signal\)/);
  assert.match(source, /error instanceof DOMException && error\.name === "AbortError"/);
});

test("ChatWindow gate and useAgentSession effect deliver loader and cleanup callbacks", async () => {
  const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(chatWindowSource, /const reportSystemInfoLoaderChange = useCallback\(\(loader: SystemInfoLoader \| null\) => \{/);
  assert.match(chatWindowSource, /if \(!shouldReportToolbar \|\| shouldReportToolbarRef\.current !== shouldReportToolbar\) return;/);
  assert.match(chatWindowSource, /onSystemInfoLoaderChangeRef\.current\?\.\(loader\);/);
  assert.match(chatWindowSource, /onSystemInfoLoaderChange: reportSystemInfoLoaderChange,/);
  assert.match(hookSource, /onSystemInfoLoaderChange\?\.\(loadSystemInfo\);/);
  assert.match(hookSource, /return \(\) => onSystemInfoLoaderChange\?\.\(null\);/);
});

test("clear aborts the in-flight token before its side effects start", async () => {
  const controller = createSystemInfoLoaderController();
  const started = [];
  const loader = async (signal) => {
    if (signal?.aborted) { started.push("aborted"); return; }
    started.push("run");
  };
  controller.register(loader);
  const run = controller.start(true);
  assert.ok(run);
  assert.equal(run.signal.aborted, false);
  // Pane unmount/removal clears the owner: the token is aborted before the
  // loader's next stage (e.g. ensureNewSession) could begin.
  assert.equal(controller.clear(), true);
  assert.equal(run.signal.aborted, true);
  await run.load(run.signal);
  assert.deepEqual(started, ["aborted"]);
  // A cleared controller cannot start again until a new loader registers.
  assert.equal(controller.start(true), null);
});

test("replacement aborts the superseded token exactly once", async () => {
  const controller = createSystemInfoLoaderController();
  const loaderA = async () => {};
  const loaderB = async () => {};
  controller.register(loaderA);
  const stale = controller.start(true);
  assert.ok(stale);
  let aborts = 0;
  stale.signal.addEventListener("abort", () => { aborts += 1; });
  // Focused-pane replacement supersedes the in-flight run.
  assert.equal(controller.register(loaderB), true);
  assert.equal(stale.signal.aborted, true);
  // Same-reference re-report and a later clear must not re-abort the token.
  assert.equal(controller.register(loaderB), false);
  assert.equal(controller.clear(), true);
  assert.equal(aborts, 1);
});

test("late settlement cannot start the next operation or clear newer loading", async () => {
  const invoked = [];
  const controller = createSystemInfoLoaderController();
  const loaderA = async (signal) => { if (signal?.aborted) return; invoked.push("A"); };
  const loaderB = async (signal) => { if (signal?.aborted) return; invoked.push("B"); };
  controller.register(loaderA);
  const stale = controller.start(true);
  assert.ok(stale);
  // Replacement aborts the stale token before its next stage would start.
  assert.equal(controller.register(loaderB), true);
  await stale.load(stale.signal);
  assert.deepEqual(invoked, []);
  // The stale completion cannot clear the newer load's loading state.
  assert.equal(controller.complete(stale.loadId), false);
  const current = controller.start(true);
  assert.ok(current);
  assert.equal(controller.loading, true);
  await current.load(current.signal);
  assert.equal(controller.complete(current.loadId), true);
  assert.equal(controller.loading, false);
  assert.deepEqual(invoked, ["B"]);
});

test("an active load still completes normally without abort", async () => {
  const controller = createSystemInfoLoaderController();
  let release;
  const loader = async () => { await new Promise((r) => { release = r; }); };
  controller.register(loader);
  const started = controller.start(true);
  assert.ok(started);
  assert.equal(started.signal.aborted, false);
  const pending = started.load(started.signal);
  release();
  await pending;
  assert.equal(started.signal.aborted, false);
  assert.equal(controller.complete(started.loadId), true);
  assert.equal(controller.loading, false);
});
