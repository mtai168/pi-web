import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SessionWall, getSessionWallPolicy, createOuterScrollSourceRegistry } = await jiti.import("./SessionWall.tsx");
const {
  getSessionWallPaneSlots,
  getSessionWallGridTemplate,
  isSessionWallPaneInOverscan,
} = await jiti.import("./SessionWallGrid.tsx");
const {
  getSessionWallPaneFrameStyle,
  getSessionWallPaneHeadingId,
  getSessionWallPaneRuntimeKey,
  getSessionWallActionMenuPosition,
  getSessionWallPaneStateCopy,
  getSessionWallPaneStatus,
  getSessionWallPaneColdStateCopy,
  getSessionWallPaneDiagnosticText,
  getSessionWallPaneSecondaryText,
  getSessionWallPaneAccessibleMetadata,
  SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH,
  shouldRenderSessionWallPaneContent,
  SessionWallPane,
} = await jiti.import("./SessionWallPane.tsx");
const {
  SessionWallErrorBoundary,
} = await jiti.import("./SessionWallErrorBoundary.tsx");

const paneSource = await readFile(new URL("./SessionWallPane.tsx", import.meta.url), "utf8");

test("bounds the pane action menu within the visual viewport", () => {
  const position = getSessionWallActionMenuPosition(
    { top: 760, right: 1320, bottom: 792 },
    { width: 1418, height: 800, offsetLeft: 10, offsetTop: 20 },
  );
  assert.ok(position);
  assert.ok(position.top >= 28);
  assert.ok(position.top + position.maxHeight <= 812);
  assert.ok(position.left >= 18);
  assert.ok(position.width <= 180);
  assert.match(paneSource, /createPortal\(/);
  assert.match(paneSource, /window\.visualViewport\?\.addEventListener\("scroll", schedule\)/);
});
const layoutPolicy = (layout) => getSessionWallPolicy(
  { layout },
  1418,
  845,
);

function config(layout = "2x2") {
  const slotCount = { "2x2": 4, "2x4": 8, "2x6": 12 }[layout];
  return {
    version: 1,
    wallId: "wall-1",
    name: "Test wall",
    layout,
    panes: Array.from({ length: slotCount }, (_, index) => ({
      paneId: `stable-pane-${index + 1}`,
      sessionId: `session-${index + 1}`,
    })),
    focusedPaneId: "stable-pane-1",
    outerScrollTop: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderWall(props = {}) {
  return renderToStaticMarkup(React.createElement(SessionWall, {
    config: config(),
    viewportWidth: 1418,
    availableHeight: 845,
    ...props,
  }));
}

test("mobile-disabled viewport renders an empty shell without grid or pane runtimes", () => {
  const policy = getSessionWallPolicy(config(), 640, 845);
  assert.equal(policy.viewport.mobileDisabled, true);
  assert.equal(policy.viewport.reason, "mobile-disabled");
  assert.equal(getSessionWallPolicy(config(), 720, 845).viewport.mobileDisabled, false);

  const html = renderToStaticMarkup(React.createElement(SessionWall, {
    config: config(),
    viewportWidth: 640,
    availableHeight: 845,
    renderPane: ({ pane }) => React.createElement("span", null, `content-${pane.paneId}`),
    onFocusPane() {},
  }));
  assert.match(html, /data-session-wall="true"/);
  assert.match(html, /data-session-wall-mobile-disabled="true"/);
  assert.match(html, /data-session-wall-viewport-supported="false"/);
  assert.doesNotMatch(html, /data-session-wall-grid|data-session-wall-pane-id|data-session-wall-slot-count|content-stable-pane/);
});

test("mobile-disabled guard precedes the grid and keeps the desktop composition wired", async () => {
  const source = await readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8");
  const guardStart = source.indexOf("if (policy.viewport.mobileDisabled)");
  const gridIndex = source.indexOf("<SessionWallGrid");
  assert.ok(guardStart >= 0 && guardStart < gridIndex);
  const shellReturnStart = source.indexOf("return (", guardStart);
  const shell = source.slice(shellReturnStart, source.indexOf("\n  return (\n    <div\n      ref={outerRef}", shellReturnStart));
  assert.doesNotMatch(shell, /SessionWallGrid|<SessionWallPane|ref=\{outerRef\}/);
  assert.match(shell, /data-session-wall-mobile-disabled="true"/);
  assert.match(shell, /data-session-wall-viewport-supported="false"/);
  const desktopReturn = source.slice(source.indexOf("\n  return (\n    <div\n      ref={outerRef}", guardStart));
  assert.match(desktopReturn, /<SessionWallGrid[\s\S]*?renderPane=\{\s*\(pane, index, inOverscan\) => \{/);
  assert.match(desktopReturn, /data-session-wall-viewport-supported=\{policy\.viewport\.supported \? "true" : "false"\}/);
});

test("supported presets render exactly 4, 8, and 12 slots in two columns", () => {
  for (const [layout, slotCount, rows] of [["2x2", 4, 2], ["2x4", 8, 4], ["2x6", 12, 6]]) {
    const policy = layoutPolicy(layout);
    assert.equal(policy.slotCount, slotCount);
    assert.equal(policy.columns, 2);
    assert.equal(policy.rows, rows);
    assert.equal(getSessionWallPaneSlots(config(layout).panes, policy.slotCount).length, slotCount);
    assert.deepEqual(
      getSessionWallPaneSlots(config(layout).panes, policy.slotCount).map(({ paneId }) => paneId),
      config(layout).panes.map(({ paneId }) => paneId),
    );
    assert.equal(getSessionWallGridTemplate(policy), `repeat(${rows}, ${policy.paneHeight}px)`);
  }
  assert.throws(() => getSessionWallPaneSlots([
    { paneId: "same", sessionId: "first" },
    { paneId: "same", sessionId: "second" },
  ], 4), /Duplicate Session Wall pane id/);
});

test("deduplicates pane metadata while retaining exact accessible values and focus semantics", () => {
  const metadata = {
    name: "Build session",
    project: "/work/repo",
    cwd: "/work/repo",
    branch: "main",
    updatedLabel: "just now",
  };
  assert.equal(getSessionWallPaneSecondaryText(metadata), "repo | main | just now");
  assert.equal(getSessionWallPaneAccessibleMetadata(metadata), "/work/repo | main | just now");
  const html = renderToStaticMarkup(React.createElement(SessionWallPane, {
    pane: { paneId: "pane-a", sessionId: "session-a" },
    metadata,
    focused: true,
    onExpand() {},
    onReplace() {},
    onRemove() {},
    renderContent: () => React.createElement("span", null, "content"),
  }));
  assert.doesNotMatch(html, /aria-selected=/);
  assert.doesNotMatch(paneSource, /aria-selected=/);
  assert.doesNotMatch(paneSource, /role-supports-aria-props/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /title="\/work\/repo \| main \| just now"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /More actions/);
  assert.match(paneSource, /actionsTriggerRef/);
  assert.match(paneSource, /querySelector<HTMLButtonElement>\('\[role="menuitem"\]'\)/);
  assert.match(paneSource, /actionsTriggerRef\.current\?\.focus\(\)/);
  assert.match(paneSource, /const handleMenuKeyDown/);
  assert.match(paneSource, /event\.key === "ArrowDown"/);
  assert.match(paneSource, /event\.key === "Home"/);
  assert.match(paneSource, /const closeActions = useCallback/);
  assert.match(paneSource, /const handlePointerDown[\s\S]*?if \(actionsRef\.current\?\.contains\(event\.target as Node\) \|\| actionsMenuRef\.current\?\.contains\(event\.target as Node\)\) return;[\s\S]*?closeActions\(/);
  assert.doesNotMatch(paneSource, /if \(!focused\) setActionsOpen\(false\)/);
});
test("moves the 2x6 overscan window with outer scroll and fails open for unknown geometry", () => {
  const policy = layoutPolicy("2x6");
  const viewportHeight = 845;
  const rowStep = policy.paneHeight + 1;
  const overscanRows = (scrollTop) => Array.from(
    { length: policy.slotCount },
    (_, index) => index,
  ).filter((index) => isSessionWallPaneInOverscan(index, policy, scrollTop, viewportHeight));

  assert.deepEqual(overscanRows(0), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(overscanRows(rowStep * 2), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.notDeepEqual(overscanRows(0), overscanRows(rowStep * 2));

  const twoByTwo = layoutPolicy("2x2");
  assert.deepEqual(
    Array.from({ length: twoByTwo.slotCount }, (_, index) => isSessionWallPaneInOverscan(index, twoByTwo, 0, viewportHeight)),
    Array.from({ length: twoByTwo.slotCount }, () => true),
  );

  for (const [scrollTop, height] of [[undefined, undefined], [Number.NaN, viewportHeight], [-1, viewportHeight], [0, 0], [0, Number.NaN]]) {
    assert.deepEqual(
      Array.from({ length: policy.slotCount }, (_, index) => isSessionWallPaneInOverscan(index, policy, scrollTop, height)),
      Array.from({ length: policy.slotCount }, () => true),
    );
  }
});

test("larger presets keep readable pane height and use the wall outer scroller", () => {
  const twoByTwo = layoutPolicy("2x2");
  for (const layout of ["2x4", "2x6"]) {
    const policy = layoutPolicy(layout);
    assert.equal(policy.paneHeight, twoByTwo.paneHeight);
    assert.equal(policy.requiresOuterScroll, true);
    const html = renderToStaticMarkup(React.createElement(SessionWall, {
      config: config(layout),
      viewportWidth: 1418,
      availableHeight: 845,
    }));
    assert.match(html, /data-session-wall-outer-scroll="true"/);
    assert.match(html, /overflow-y:auto/);
    assert.match(html, new RegExp(`data-session-wall-slot-count="${policy.slotCount}"`));
  }
});

test("routes blocking attention into the pane runtime policy", () => {
  const html = renderWall({
    config: config("2x6"),
    getPaneBlockingAttention: (pane) => pane.paneId === "stable-pane-11",
  });
  const paneStart = html.indexOf('data-session-wall-pane-id="stable-pane-11"');
  assert.ok(paneStart >= 0);
  const paneHtml = html.slice(paneStart, paneStart + 900);
  assert.match(paneHtml, /data-session-wall-runtime-tier="hot"/);
  assert.match(paneHtml, /data-session-wall-runtime-reason="blocking-attention"/);
  assert.match(paneHtml, /data-session-wall-session-id="session-11"/);
});

test("restores and debounces outer scroll through the wall config boundary", async () => {
  const source = await readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8");
  assert.match(source, /ref=\{outerRef\}/);
  assert.match(source, /onScroll=\{handleOuterScroll\}/);
  assert.match(source, /OUTER_SCROLL_SAVE_DEBOUNCE_MS = 200/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*?flushOuterScrollPersistence\(\);[\s\S]*?\}, OUTER_SCROLL_SAVE_DEBOUNCE_MS\)/);
  assert.match(source, /element\.scrollHeight - viewportHeight/);
  assert.match(source, /clampOuterScrollTop\(/);
  assert.match(source, /restoredOuterScrollKeyRef\.current !== restoreKey/);
  assert.match(source, /queueOuterScrollPersistence\(clampedScrollTop\)/);
  assert.match(source, /pendingOuterScrollRef\.current\.wallId !== config\.wallId/);
  assert.match(source, /flushOuterScrollPersistence\(\);/);
});

test("fences outer scroll callbacks by per-mount source identity and flushes before unregister", async () => {
  const source = await readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8");
  assert.match(source, /onOuterScrollTopChange\?: \(wallId: string, outerScrollTop: number, sourceId: object, transitionFlush\?: boolean\) => void/);
  assert.match(source, /onOuterScrollSourceChange\?: \(wallId: string, sourceId: object, active: boolean\) => void/);
  assert.match(source, /const outerScrollSourceRef = useRef<object>\(\{\}\)/);
  assert.match(source, /onOuterScrollTopChangeRef\.current\?\.\(pending\.wallId, pending\.scrollTop, outerScrollSourceRef\.current, transitionFlush\)/);
  assert.match(source, /const sourceId = outerScrollSourceRef\.current;/);
  assert.match(source, /onOuterScrollSourceChangeRef\.current\?\.\(config\.wallId, sourceId, true\)/);
  assert.match(
    source,
    /return \(\) => \{\s+if \(pendingOuterScrollRef\.current\?\.wallId === config\.wallId\) flushOuterScrollPersistence\(true\);\s+onOuterScrollSourceChangeRef\.current\?\.\(config\.wallId, sourceId, false\);/,
  );
  assert.match(source, /\[config\.wallId, flushOuterScrollPersistence, policy\.viewport\.mobileDisabled\]\);/);
});

test("mobile-disabled transition cancels pending outer-scroll work and unregisters the source", async () => {
  const source = await readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8");
  const disabledBranch = /if \(policy\.viewport\.mobileDisabled\) \{\s+if \(outerScrollTimerRef\.current\) \{\s+clearTimeout\(outerScrollTimerRef\.current\);\s+outerScrollTimerRef\.current = null;\s+\}\s+pendingOuterScrollRef\.current = null;\s+restoredOuterScrollKeyRef\.current = null;\s+return;\s+\}/;
  assert.match(source, disabledBranch);
  const branch = disabledBranch.exec(source)[0];
  assert.doesNotMatch(branch, /onOuterScrollSourceChangeRef/);
  assert.doesNotMatch(branch, /SessionWallGrid|onScroll=/);
  assert.match(source, /const outerScrollDisabledRef = useRef\(false\);/);
  assert.match(source, /outerScrollDisabledRef\.current = policy\.viewport\.mobileDisabled;/);
  assert.match(source, /if \(outerScrollDisabledRef\.current\) \{\s+pendingOuterScrollRef\.current = null;\s+return;\s+\}/);
});

test("desktop re-entry re-runs registration, observation, and scroll restore on the disabled transition", async () => {
  const source = await readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8");
  assert.match(source, /\[availableHeight, config\.wallId, policy\.contentHeight, policy\.viewport\.mobileDisabled\]\);/);
  assert.match(
    source,
    /\[config\.layout, config\.outerScrollTop, config\.wallId, outerViewportHeight, policy\.contentHeight, policy\.viewport\.mobileDisabled, queueOuterScrollPersistence\]\);/,
  );
  assert.match(source, /const viewportHeight = element\.clientHeight;/);
  assert.match(source, /restoredOuterScrollKeyRef\.current !== restoreKey/);
  assert.match(source, /element\.scrollTop = clampedScrollTop;/);
  assert.match(source, /clampOuterScrollTop\(/);
  const guardStart = source.indexOf("if (policy.viewport.mobileDisabled)");
  const shell = source.slice(guardStart, source.indexOf("\n  return (\n    <div\n      ref={outerRef}", guardStart));
  assert.doesNotMatch(shell, /ref=\{outerRef\}|onScroll=|SessionWallGrid/);
});

test("current source accepts a claim; stale callbacks are rejected at acceptClaim", () => {
  const registry = createOuterScrollSourceRegistry();
  const source = {};
  registry.register("wall-1", source);
  assert.equal(registry.isCurrent("wall-1", source), true);
  assert.ok(registry.acceptClaim("wall-1", source));
  assert.equal(registry.unregister("wall-1", source), true);
  assert.equal(registry.isCurrent("wall-1", source), false);
  assert.equal(registry.acceptClaim("wall-1", source), null);
  assert.equal(registry.isValidClaim("wall-1", source, {}), false);
});

test("old unregister cannot remove a replacement source", () => {
  const registry = createOuterScrollSourceRegistry();
  const first = {};
  const second = {};
  registry.register("wall-1", first);
  registry.register("wall-1", second);
  assert.equal(registry.unregister("wall-1", first), false);
  assert.equal(registry.isCurrent("wall-1", second), true);
  assert.equal(registry.isCurrent("wall-1", first), false);
});

test("a claim accepted by source A cannot validate for source B or another wall", () => {
  const registry = createOuterScrollSourceRegistry();
  const first = {};
  const second = {};
  registry.register("wall-1", first);
  const claim = registry.acceptClaim("wall-1", first);
  assert.ok(claim);
  assert.equal(registry.isValidClaim("wall-2", first, claim), false);
  assert.equal(registry.isValidClaim("wall-1", second, claim), false);
  assert.equal(registry.isValidClaim("wall-1", first, claim), true);
  registry.register("wall-1", second);
  assert.equal(registry.isValidClaim("wall-1", first, claim), false);
});

test("an ordinary claim becomes invalid after unregister and after source replacement", () => {
  const registry = createOuterScrollSourceRegistry();
  const source = {};
  registry.register("wall-1", source);
  const claim = registry.acceptClaim("wall-1", source);
  assert.ok(claim);
  registry.unregister("wall-1", source);
  assert.equal(registry.isValidClaim("wall-1", source, claim), false);
  registry.register("wall-1", source);
  const replacement = {};
  registry.register("wall-1", replacement);
  assert.equal(registry.isValidClaim("wall-1", source, claim), false);
});

test("a transition claim accepted before unregister stays valid after unregister/replacement and is replay-safe", () => {
  const registry = createOuterScrollSourceRegistry();
  const source = {};
  registry.register("wall-1", source);
  const claim = registry.acceptClaim("wall-1", source, true);
  assert.ok(claim);
  registry.unregister("wall-1", source);
  assert.equal(registry.isValidClaim("wall-1", source, claim), true);
  assert.equal(registry.isValidClaim("wall-1", source, claim), true);
  const replacement = {};
  registry.register("wall-1", replacement);
  assert.equal(registry.isValidClaim("wall-1", source, claim), true);
  assert.equal(registry.isValidClaim("wall-2", source, claim), false);
  assert.equal(registry.isValidClaim("wall-1", replacement, claim), false);
  assert.equal(registry.acceptClaim("wall-1", source), null);
});

test("cold panes gate content but preserve normal and non-ready behavior", () => {
  assert.equal(shouldRenderSessionWallPaneContent("ready", "hot"), true);
  assert.equal(shouldRenderSessionWallPaneContent("ready", "warm"), true);
  assert.equal(shouldRenderSessionWallPaneContent("ready", "cold"), false);
  assert.equal(shouldRenderSessionWallPaneContent("stale", "cold"), false);
  assert.deepEqual(
    getSessionWallPaneColdStateCopy(
      { paneId: "pane-7", sessionId: "session-7" },
      "Build worker",
      { cold: "Not loaded", coldDescription: "Scroll into view." },
    ),
    { title: "Not loaded", description: "Build worker (session-7): Scroll into view." },
  );
});

test("bounds diagnostic and cold copy text while preserving recovery controls", () => {
  const oversized = "diagnostic-".repeat(SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH);
  const bounded = getSessionWallPaneDiagnosticText(`  ${oversized}  `);
  assert.equal(bounded.length, SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH);
  assert.match(bounded, /\.\.\.$/);
  assert.equal(getSessionWallPaneDiagnosticText("  short message  "), "short message");
  assert.equal(getSessionWallPaneDiagnosticText(null), "");

  const coldCopy = getSessionWallPaneColdStateCopy(
    { paneId: "pane-7", sessionId: oversized },
    oversized,
    { cold: "Not loaded", coldDescription: "Scroll this pane into view." },
  );
  assert.ok(coldCopy.description.length <= SESSION_WALL_PANE_DIAGNOSTIC_MAX_LENGTH);
  assert.doesNotMatch(coldCopy.description, new RegExp(oversized));

  const html = renderWall({
    paneStates: { "stable-pane-2": { status: "error", message: oversized, detail: oversized } },
    onRetryPane() {},
    onReplacePane() {},
    onRemovePane() {},
  });
  assert.doesNotMatch(html, new RegExp(oversized));
  assert.match(html, /max-height:4\.35em/);
  assert.match(html, /max-height:2\.8em/);
  assert.match(html, />Retry</);
});

test("focused styling preserves the border geometry", () => {
  const idle = getSessionWallPaneFrameStyle(false);
  const focused = getSessionWallPaneFrameStyle(true);
  assert.equal(idle.border, "1px solid var(--border)");
  assert.equal(focused.border, idle.border);
  assert.equal(idle.outline, "none");
  assert.equal(focused.outline, "2px solid var(--accent)");
  assert.equal(focused.outlineOffset, "-2px");
  assert.notEqual(getSessionWallPaneHeadingId("a b"), getSessionWallPaneHeadingId("a-b"));
});

test("empty, stale, loading, and error states expose recovery contracts", () => {
  assert.equal(getSessionWallPaneStatus({ sessionId: null }), "empty");
  assert.equal(getSessionWallPaneStatus({ sessionId: "session" }, { status: "stale" }), "stale");
  assert.equal(getSessionWallPaneStatus({ sessionId: "session" }, { status: "loading" }), "loading");
  assert.equal(getSessionWallPaneStatus({ sessionId: "session" }, { status: "error" }), "error");
  assert.equal(getSessionWallPaneStateCopy("stale", {
    emptySlot: "Empty", emptyDescription: "Choose", loading: "Loading", loadingDescription: "Wait",
    stale: "Stale", staleDescription: "Refresh", unavailable: "Unavailable", unavailableDescription: "Missing",
    error: "Error", errorDescription: "Failed",
  }).role, "alert");

  const stateConfig = config();
  stateConfig.panes[0].sessionId = null;
  const html = renderWall({
    config: stateConfig,
    paneStates: {
      "stable-pane-2": { status: "stale", message: "Refresh this session." },
      "stable-pane-3": { status: "loading" },
      "stable-pane-4": { status: "error", message: "The session failed to load." },
    },
    renderPane: ({ pane }) => React.createElement("span", null, `content-${pane.paneId}`),
    onSelectEmptyPane() {},
    onRetryPane() {},
    onReplacePane() {},
    onRemovePane() {},
  });
  assert.match(html, /Select session/);
  const contentHtml = renderWall({
    renderPane: ({ pane }) => React.createElement("span", null, `content-${pane.paneId}`),
  });
  assert.match(contentHtml, /content-stable-pane-1/);
  assert.match(html, /Session is stale/);
  assert.match(html, /Loading session/);
  assert.match(html, /Session error/);
  assert.match(html, /Refresh this session/);
  assert.match(html, /Retry/);
  assert.match(html, /Replace/);
  assert.match(html, /Remove/);
});

test("one pane boundary has injectable recovery while sibling content stays renderable", async () => {
  const boundaryState = SessionWallErrorBoundary.getDerivedStateFromError(new Error("broken"));
  assert.equal(boundaryState.error?.message, "broken");
  const boundary = new SessionWallErrorBoundary({ children: "child", paneLabel: "pane-a", onReplace() {}, onRemove() {} });
  boundary.state = { error: new Error("/private/path"), retryVersion: 0 };
  const recoveryHtml = renderToStaticMarkup(boundary.render());
  assert.match(recoveryHtml, /Pane content unavailable/);
  assert.doesNotMatch(recoveryHtml, /private\/path/);

  const [wallSource, paneSource, boundarySource, gridSource] = await Promise.all([
    readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8"),
    readFile(new URL("./SessionWallPane.tsx", import.meta.url), "utf8"),
    readFile(new URL("./SessionWallErrorBoundary.tsx", import.meta.url), "utf8"),
    readFile(new URL("./SessionWallGrid.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(wallSource, /renderPane=\{\(pane, index, inOverscan\) => \{/);
  assert.match(wallSource, /key=\{getSessionWallPaneRuntimeKey\(pane\)\}/);
  assert.match(wallSource, /getPaneBlockingAttention/);
  assert.match(paneSource, /useSessionWallVisibility\(/);
  assert.match(paneSource, /data-session-wall-runtime-tier=\{visibility\.tier\}/);
  assert.match(paneSource, /data-session-wall-runtime-reason=\{visibility\.policy\.reason\}/);
  assert.match(paneSource, /<PaneBody key=\{runtime\.runtimeKey\}/);
  assert.equal(getSessionWallPaneRuntimeKey({ paneId: "pane-a", sessionId: "session-a", runtimeRevision: 1 }), '["pane-a","session-a",1]');
  assert.notEqual(
    getSessionWallPaneRuntimeKey({ paneId: "pane-a", sessionId: "session-a", runtimeRevision: 1 }),
    getSessionWallPaneRuntimeKey({ paneId: "pane-a", sessionId: "session-b", runtimeRevision: 1 }),
  );

  assert.match(paneSource, /<SessionWallErrorBoundary[\s\S]*?<PaneBody/);
  assert.match(boundarySource, /static getDerivedStateFromError/);
  assert.match(boundarySource, /resetKey/);
  assert.match(boundarySource, /onRetry/);
  for (const source of [wallSource, paneSource, gridSource]) {
    assert.doesNotMatch(source, /sendAgentCommand|clearQueue|clear_queue|clearDraft|new EventSource|fetch\(|onAbort=|createSession/);
  }
});

test("a missing session keeps its slot and is not substituted", () => {
  const stateConfig = config();
  stateConfig.panes[1].sessionId = "deleted-session";
  const html = renderWall({
    config: stateConfig,
    paneStates: {
      "stable-pane-2": { status: "stale", message: "This session is unavailable right now." },
    },
    renderPane: ({ pane }) => React.createElement("span", null, `content-${pane.paneId}`),
    onRetryPane() {},
    onReplacePane() {},
    onRemovePane() {},
  });
  assert.match(html, /data-session-wall-session-id="deleted-session"/);
  assert.match(html, /Session is stale/);
  assert.doesNotMatch(html, /content-stable-pane-2/);
  assert.match(html, /content-stable-pane-1/);
  assert.match(html, /content-stable-pane-3/);
});

test("retry and resetKey reset only the failed boundary instance", () => {
  const retried = [];
  const failed = new SessionWallErrorBoundary({
    children: "a",
    paneLabel: "pane-a",
    resetKey: "same",
    onRetry: () => retried.push("pane-a"),
  });
  const sibling = new SessionWallErrorBoundary({ children: "b", paneLabel: "pane-b" });
  sibling.state = { error: new Error("boom"), retryVersion: 0 };

  // React's setState is a no-op on never-mounted instances; shim the updater
  // to apply the boundary's own state transitions synchronously.
  failed.updater = {
    enqueueSetState(instance, partialState) {
      const next = typeof partialState === "function" ? partialState(instance.state) : partialState;
      instance.state = { ...instance.state, ...next };
    },
  };
  failed.state = { error: new Error("boom"), retryVersion: 0 };

  failed.retry();
  assert.equal(failed.state.error, null);
  assert.equal(failed.state.retryVersion, 1);
  assert.deepEqual(retried, ["pane-a"]);
  assert.equal(sibling.state.error?.message, "boom");

  failed.state = { error: new Error("boom"), retryVersion: 1 };
  failed.componentDidUpdate({ children: "a", paneLabel: "pane-a", resetKey: "same" });
  assert.equal(failed.state.error?.message, "boom");

  failed.componentDidUpdate({ children: "a", paneLabel: "pane-a", resetKey: "next" });
  assert.equal(failed.state.error, null);
  assert.equal(failed.state.retryVersion, 2);
  assert.equal(sibling.state.error?.message, "boom");
});

test("pane recovery callbacks stay scoped to their pane", async () => {
  const wallSource = await readFile(new URL("./SessionWall.tsx", import.meta.url), "utf8");
  assert.match(wallSource, /const action = \(callback[\s\S]*?\) => \([\s\S]*?callback\(pane\)/);
  assert.match(wallSource, /onRetry=\{action\(onRetryPane\)\}/);
  assert.match(wallSource, /onReplace=\{action\(onReplacePane\)\}/);
  assert.match(wallSource, /onRemove=\{action\(onRemovePane\)\}/);
  assert.notEqual(
    getSessionWallPaneRuntimeKey({ paneId: "pane-1", sessionId: "session-a" }),
    getSessionWallPaneRuntimeKey({ paneId: "pane-2", sessionId: "session-a" }),
  );
});

test("wall components stay presentational and do not add runtime or catalog coupling", async () => {
  const files = [
    "SessionWall.tsx",
    "SessionWallGrid.tsx",
    "SessionWallPane.tsx",
    "SessionWallEmptyPane.tsx",
    "SessionWallErrorBoundary.tsx",
  ];
  const sources = await Promise.all(files.map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /ChatWindow|useAgentSession|EventSource|fetch\(|\/api\/sessions|AppShell|SessionSidebar/);
  }
});

test("pane mount instrumentation is attached once at the pane lifecycle boundary", async () => {
  const paneSource = await readFile(new URL("./SessionWallPane.tsx", import.meta.url), "utf8");
  assert.equal((paneSource.match(/bumpSessionWallDiagnostic\("paneMounts"\)/g) ?? []).length, 1);
  assert.equal((paneSource.match(/bumpSessionWallDiagnostic\("paneUnmounts"\)/g) ?? []).length, 1);
  assert.match(paneSource, /useEffect\(\(\) => \{[\s\S]*?bumpSessionWallDiagnostic\("paneMounts"\)[\s\S]*?return \(\) => bumpSessionWallDiagnostic\("paneUnmounts"\)/);
});
