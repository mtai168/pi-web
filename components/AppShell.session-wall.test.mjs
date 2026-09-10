import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("keeps normal mode as the default and preserves the existing chat path", () => {
  assert.match(source, /type WorkspaceMode = "normal" \| "wall"/);
  assert.match(source, /useState<WorkspaceMode>\("normal"\)/);
  assert.match(source, /data-workspace-mode=\{workspaceMode\}/);
  assert.match(source, /data-normal-chat-controller="true"/);
  assert.match(source, /\{workspacePreferenceHydrated \? showChat \? \(\s*<ChatWindow/);
  assert.match(source, /sessionRunning=\{Boolean\(selectedSession && runningSessionIds\.has\(selectedSession\.id\)\)\}/);
  assert.match(source, /onSessionCreated=\{handleSessionCreated\}/);
  assert.match(source, /onSessionForked=\{handleSessionForked\}/);
  assert.match(source, /onOpenFile=\{handleOpenLinkedFile\}/);
});

test("keeps the live chat controller hidden and click-through in wall mode", () => {
  const wallIndex = source.indexOf('data-session-wall-workspace="true"');
  const controllerIndex = source.indexOf('data-normal-chat-controller="true"');
  assert.ok(wallIndex >= 0 && wallIndex < controllerIndex);
  assert.match(
    source,
    /display: workspacePreferenceHydrated && workspaceMode === "normal" \? "contents" : "none"[\s\S]*?pointerEvents: workspaceMode === "wall" \? "none" : "auto"/,
  );
  assert.match(source, /aria-hidden=\{workspaceMode === "wall" \? true : undefined\}/);
  assert.doesNotMatch(source, /workspaceMode === "wall" \? \([\s\S]*?<ChatWindow/);
});

test("hides both side panels from layout and interaction while wall mode is active", () => {
  assert.match(source, /const panelsVisible = workspaceMode === "normal"/);
  assert.match(source, /const sidebarVisible = panelsVisible && sidebarOpen/);
  assert.match(source, /const rightPanelVisible = panelsVisible && rightPanelOpen/);
  assert.match(source, /className=\{`sidebar-container\$\{sidebarVisible \? " sidebar-open" : " sidebar-closed"/);
  assert.match(source, /\{sidebarVisible && \(\s*<div[\s\S]*?data-resize-handle="sidebar"/);
  assert.match(source, /className=\{`right-panel-container\$\{rightPanelVisible \? " right-panel-open" : " right-panel-closed"/);
  assert.match(source, /className=\{`right-panel-overlay-backdrop\$\{rightPanelVisible \? " is-open" : ""\}`/);
  assert.match(source, /const disabled = workspaceMode === "wall" \|\| covered/);
  assert.match(source, /watchEnabled=\{rightPanelOpen\}/);
  assert.match(source, /id="session-sidebar"\s+aria-hidden=\{workspaceMode === "wall" \? true : undefined\}\s+inert=\{workspaceMode === "wall" \? true : undefined\}/);
  assert.match(source, /id="file-panel"\s+aria-hidden=\{workspaceMode === "wall" \? true : undefined\}\s+inert=\{workspaceMode === "wall" \? true : undefined\}/);
  assert.match(
    source,
    /data-workspace-mode=\{workspaceMode\}\s+onKeyDownCapture=\{\(event\) => \{[\s\S]*?if \(workspaceMode !== "wall" \|\| event\.key !== "Escape"\) return;[\s\S]*?event\.stopPropagation\(\);/,
  );
});

test("snapshots panel state on entry and restores it on exit", () => {
  const modeSource = callbackBody("handleWorkspaceModeChange", "toggleTopPanel");
  assert.match(modeSource, /preWallPanelStateRef\.current = \{ sidebarOpen, rightPanelOpen \}/);
  assert.match(modeSource, /setSidebarOpen\(false\)/);
  assert.match(modeSource, /setRightPanelOpen\(false\)/);
  assert.match(modeSource, /const previous = preWallPanelStateRef\.current/);
  assert.match(modeSource, /setSidebarOpen\(isMobile \? false : previous\?\.sidebarOpen \?\? false\)/);
  assert.match(modeSource, /setRightPanelOpen\(previous\?\.rightPanelOpen \?\? false\)/);
  assert.match(modeSource, /preWallPanelStateRef\.current = null/);
});

test("switching modes does not invoke agent abort or replace its running-session authority", () => {
  const modeSource = callbackBody("handleWorkspaceModeChange", "toggleTopPanel");
  assert.doesNotMatch(modeSource, /abort/i);
  assert.match(source, /sessionRunning=\{Boolean\(selectedSession && runningSessionIds\.has\(selectedSession\.id\)\)\}/);
  assert.match(source, /data-normal-chat-controller="true"[\s\S]*?key=\{sessionKey\}/);
});

test("enters Wall with one current-wall add/focus transition", () => {
  const modeSource = callbackBody("handleWorkspaceModeChange", "toggleTopPanel");
  assert.equal((modeSource.match(/updateActiveSessionWall\(/g) ?? []).length, 1);
  assert.match(modeSource, /updateActiveSessionWall\(\(wall\) => addAndFocusSessionWall\(wall, selectedSession\.id, updatedAt\)\)/);
  assert.doesNotMatch(modeSource, /dispatchSessionWallAction\(\{ type: "(add|focus)"/);
  assert.doesNotMatch(modeSource, /activeSessionWall\.panes/);
  assert.match(source, /function addAndFocusSessionWall\([\s\S]*?const existing = wall\.panes\.find\([\s\S]*?type: "add"[\s\S]*?const target = nextWall\.panes\.find\([\s\S]*?type: "focus"[\s\S]*?paneId: target\.paneId/);
});

test("fails closed for stale Wall pane side-effect callbacks", () => {
  const guardStart = source.indexOf("const acceptsWallPaneCallback");
  const guardEnd = source.indexOf("\n  const focusedWallPane", guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  const guardSource = source.slice(guardStart, guardEnd);
  assert.match(guardSource, /workspaceModeRef\.current !== "wall"/);
  assert.match(guardSource, /activeSessionWallRef\.current/);
  assert.match(guardSource, /wall\.wallId !== capturedWallId/);
  assert.match(guardSource, /candidate\.paneId === capturedPane\.paneId/);
  assert.match(guardSource, /currentPane\.sessionId !== capturedPane\.sessionId/);
  assert.match(guardSource, /currentPane\.runtimeRevision \?\? 0\).*capturedPane\.runtimeRevision \?\? 0/);
  assert.match(guardSource, /getSessionWallPaneRuntimeKey\(currentPane\) === capturedRuntimeKey/);

  const renderSource = source.slice(source.indexOf("const renderSessionWallPane"), source.indexOf("const sidebarContent"));
  assert.match(renderSource, /const acceptsPaneCallback = \(\) => acceptsWallPaneCallback\(/);
  assert.match(renderSource, /onAgentEnd=\{\(\) => \{[\s\S]*?if \(!acceptsPaneCallback\(\)\) return;[\s\S]*?handleAgentEndForSession\(session\);/);
  assert.match(renderSource, /onAttentionNeeded=\{\(request\) => \{[\s\S]*?if \(!acceptsPaneCallback\(\)\) return;[\s\S]*?handleAttentionNeededForSession\(request, session\);/);
  assert.match(renderSource, /onOpenFile=\{\(filePath\) => \{[\s\S]*?if \(!acceptsPaneCallback\(\)\) return;[\s\S]*?handleWallOpenFile\(session, filePath\);/);
});


test("fences wall blocking attention by wall, pane, session, and runtime identity", () => {
  const handlerStart = source.indexOf("const handleWallBlockingAttention");
  const handlerEnd = source.indexOf("\n  const getSessionWallPaneBlockingAttention", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /workspaceModeRef\.current !== "wall" \|\| !identity\.wallId/);
  assert.match(handlerSource, /wall\.wallId === identity\.wallId/);
  assert.match(handlerSource, /pane\.sessionId === identity\.sessionId/);
  assert.match(handlerSource, /getSessionWallPaneRuntimeKey\(pane\) === identity\.runtimeKey/);
  assert.match(handlerSource, /if \(blocking && !isCurrent\(\)\) return;/);
  assert.match(handlerSource, /delete next\[identity\.paneId\]/);

  const readerStart = source.indexOf("const getSessionWallPaneBlockingAttention");
  const readerEnd = source.indexOf("\n  const wallBrainStatusIdentities", readerStart);
  assert.ok(readerStart >= 0 && readerEnd > readerStart);
  const readerSource = source.slice(readerStart, readerEnd);
  assert.match(readerSource, /attention\.wallId === activeSessionWallId/);
  assert.match(readerSource, /attention\.sessionId === pane\.sessionId/);
  assert.match(readerSource, /attention\.runtimeKey === getSessionWallPaneRuntimeKey\(pane\)/);
});


test("fences outer scroll persistence by live source and preserves updatedAt", () => {
  const handlerStart = source.indexOf("const handleWallOuterScrollTopChange");
  const handlerEnd = source.indexOf("\n  const dispatchSessionWallAction", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /if \(!Number\.isFinite\(outerScrollTop\) \|\| outerScrollTop < 0\) return;/);
  assert.match(handlerSource, /const claim = registry\.acceptClaim\(wallId, sourceId, transitionFlush\);/);
  assert.match(handlerSource, /transitionFlush = false/);
  assert.match(handlerSource, /if \(claim === null\) return;/);
  assert.ok(handlerSource.indexOf("registry.acceptClaim") < handlerSource.indexOf("setSessionWalls"));
  assert.match(handlerSource, /if \(!registry\.isValidClaim\(wallId, sourceId, claim\)\) return currentStore;/);
  assert.doesNotMatch(handlerSource, /consumeClaim|markUsed|\.delete\(/);
  assert.match(handlerSource, /wall\.wallId === wallId/);
  assert.match(handlerSource, /if \(currentWall\.outerScrollTop === outerScrollTop\) return currentStore;/);
  assert.match(handlerSource, /outerScrollTop,/);
  assert.doesNotMatch(handlerSource, /updatedAt/);

  const registerStart = source.indexOf("const handleOuterScrollSourceChange");
  const registerEnd = source.indexOf("\n  const handleWallOuterScrollTopChange", registerStart);
  assert.ok(registerStart >= 0 && registerEnd > registerStart);
  const registerSource = source.slice(registerStart, registerEnd);
  assert.match(source, /const outerScrollRegistryRef = useRef\(createOuterScrollSourceRegistry\(\)\)/);
  assert.match(registerSource, /\(wallId: string, sourceId: object, active: boolean\)/);
  assert.match(registerSource, /if \(active\) registry\.register\(wallId, sourceId\)/);
  assert.match(registerSource, /else registry\.unregister\(wallId, sourceId\)/);
});


test("marks only cleanup and wall-switch flushes as transition flushes", async () => {
  const wallSource = await readFile(new URL("./session-wall/SessionWall.tsx", import.meta.url), "utf8");
  assert.equal((wallSource.match(/flushOuterScrollPersistence\(true\)/g) ?? []).length, 3);
  assert.match(wallSource, /setTimeout\(\(\) => \{[\s\S]*?flushOuterScrollPersistence\(\);/);
  assert.match(wallSource, /onOuterScrollTopChange\?: \(wallId: string, outerScrollTop: number, sourceId: object, transitionFlush\?: boolean\) => void/);
  assert.match(wallSource, /if \(pending\) onOuterScrollTopChangeRef\.current\?\.\(pending\.wallId, pending\.scrollTop, outerScrollSourceRef\.current, transitionFlush\)/);
});


test("wires blocking attention and outer scroll through the wall composition", () => {
  const wallStart = source.indexOf("<SessionWall");
  const wallEnd = source.indexOf("\n              )}\n              {sessionWallPickerOpen", wallStart);
  assert.ok(wallStart >= 0 && wallEnd > wallStart);
  const wallSource = source.slice(wallStart, wallEnd);
  assert.match(wallSource, /getPaneBlockingAttention=\{getSessionWallPaneBlockingAttention\}/);
  assert.match(wallSource, /onOuterScrollTopChange=\{handleWallOuterScrollTopChange\}/);
  assert.match(wallSource, /onOuterScrollSourceChange=\{handleOuterScrollSourceChange\}/);

  const renderSource = source.slice(source.indexOf("const renderSessionWallPane"), source.indexOf("const sidebarContent"));
  assert.match(renderSource, /onBlockingAttentionChange=\{handleWallBlockingAttention\}/);
  assert.match(renderSource, /wallModeActive=\{workspaceMode === "wall"\}/);
  assert.match(renderSource, /brainStatusIdentity=\{\{/);
  assert.match(renderSource, /wallId: activeSessionWallId,/);
});


test("wall mode guards shared top panels, stats, and mobile-more actions", () => {
  assert.match(callbackBody("toggleTopPanel", "handleSystemInfoToggle"), /if \(workspaceModeRef\.current === "wall"\) return;/);
  assert.match(callbackBody("handleSystemInfoToggle", "openSessionStatsPanel"), /if \(workspaceMode === "wall"\) return;/);
  assert.match(callbackBody("openSessionStatsPanel", "handleSidebarToggle"), /if \(workspaceMode === "wall"\) return;/);
  assert.match(callbackBody("handleMobileToolbarMoreToggle", "handleRightPanelToggle"), /if \(workspaceMode === "wall"\) return;/);
  assert.match(source, /isNarrowMobile && panelsVisible && mobileToolbarMoreOpen/);
  assert.match(source, /panelsVisible && activeTopPanel && topPanelPos/);
  assert.match(source, /workspaceMode !== "wall"\) setMobileToolbarMoreOpen\(true\)/);
});

test("hydrates the saved mode before mounting chat and gives explicit navigation precedence", () => {
  assert.match(source, /const \[workspacePreferenceHydrated, setWorkspacePreferenceHydrated\] = useState\(false\)/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s+if \(workspacePreferenceLoadedRef\.current\) return;[\s\S]*?const initialMode: WorkspaceMode = hasExplicitInitialNavigation \|\| matchesMobileViewport\(\)\s+\? "normal"\s+: readWorkspaceModePreference\(\);[\s\S]*?setWorkspacePreferenceHydrated\(true\);/,
  );
  assert.match(source, /function matchesMobileViewport\(\): boolean \{[\s\S]*?matchMedia\(\"\(max-width: 640px\)\"\)\.matches/);
  assert.doesNotMatch(source, /if \(!mobileSidebarReady \|\| workspacePreferenceLoadedRef\.current\)/);
  assert.match(
    source,
    /const hasExplicitInitialNavigation = initialNavigation\.sessionId !== null\s+\|\| initialNavigation\.requestedCwd !== null;/,
  );
  const hydrationStart = source.indexOf("const initialMode: WorkspaceMode");
  assert.ok(hydrationStart >= 0);
  assert.ok(
    source.indexOf("hasExplicitInitialNavigation", hydrationStart)
      < source.indexOf("readWorkspaceModePreference()", hydrationStart),
  );
  assert.match(source, /const WORKSPACE_MODE_STORAGE_KEY = "pi-web:workspace-mode:v1"/);
  assert.match(source, /setWorkspaceMode\(nextMode\);\s*saveWorkspaceModePreference\(nextMode\);/);
});

test("repairs the selected session after persisted Wall hydration", () => {
  assert.match(source, /const persistedWallEntryPendingRef = useRef\(false\)/);
  assert.match(source, /persistedWallEntryPendingRef\.current = initialMode === "wall"/);
  const effectStart = source.indexOf("useEffect(() => {\n    if (!persistedWallEntryPendingRef");
  const effectEnd = source.indexOf("\n\n  const dispatchSessionWallAction", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);
  const effectSource = source.slice(effectStart, effectEnd);
  assert.match(effectSource, /!workspacePreferenceHydrated/);
  assert.match(effectSource, /!sessionWallHydrated/);
  assert.match(effectSource, /workspaceMode !== "wall"/);
  assert.match(effectSource, /if \(!selectedSession\?\.id\) return;/);
  assert.match(effectSource, /updateActiveSessionWall\(\(wall\) => addAndFocusSessionWall\(wall, sessionId, updatedAt\)\)/);
  assert.doesNotMatch(effectSource, /type: "replace"/);
});


test("mobile viewport disables the workspace mode control with an explicit contract", () => {
  const buttonStart = source.indexOf("const renderWorkspaceModeButton");
  const buttonEnd = source.indexOf("const renderProjectTrustWarning", buttonStart);
  assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
  const buttonSource = source.slice(buttonStart, buttonEnd);
  assert.match(buttonSource, /const wallUnavailable = isMobile && !wallActive/);
  assert.match(buttonSource, /disabled=\{wallUnavailable\}/);
  assert.match(buttonSource, /data-workspace-mode-mobile-disabled=\{wallUnavailable \? "true" : undefined\}/);
  assert.match(buttonSource, /onClick=\{\(\) => handleWorkspaceModeChange\(wallActive \? "normal" : "wall"\)\}/);
  assert.match(buttonSource, /aria-pressed=\{wallActive\}/);
});

test("blocks Wall entry at the mobile breakpoint without side effects", () => {
  const modeSource = callbackBody("handleWorkspaceModeChange", "toggleTopPanel");
  assert.match(modeSource, /if \(nextMode === "wall" && isMobile\) return;/);
  const guardIndex = modeSource.indexOf('if (nextMode === "wall" && isMobile) return;');
  assert.ok(guardIndex >= 0 && guardIndex < modeSource.indexOf('if (nextMode === "wall") {'));
  assert.doesNotMatch(modeSource, /abort/i);
  assert.doesNotMatch(modeSource, /setSelectedSession|saveSessionWalls|setSessionWalls/);
});

test("exits Wall when the viewport crosses into mobile and keeps normal mode usable", () => {
  const effectStart = source.indexOf("// Wall is unavailable at the mobile breakpoint");
  assert.ok(effectStart >= 0);
  const exitEffect = source.slice(effectStart, source.indexOf("// Single active panel — only one dropdown open at a time", effectStart));
  assert.match(exitEffect, /useEffect\(\(\) => \{\s+if \(isMobile && workspaceMode === "wall"\) \{\s+handleWorkspaceModeChange\("normal"\);\s+\}\s+\}, \[handleWorkspaceModeChange, isMobile, workspaceMode\]\);/);
  assert.doesNotMatch(exitEffect, /abort|setSelectedSession|saveSessionWalls|setSessionWalls|replace|clear/);
  assert.match(source, /const initialMode: WorkspaceMode = hasExplicitInitialNavigation \|\| matchesMobileViewport\(\)\s+\? "normal"\s+: readWorkspaceModePreference\(\);/);
});

test("localizes the mode control and wall status in every supported locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["workspace.enterWall", "workspace.exitWall", "workspace.wall", "workspace.wallPlaceholder", "workspace.wallStatus"]) {
      assert.match(messages, new RegExp(`"${key}"`));
    }
  }
});

test("keeps the Wall toolbar in the top bar and removes the redundant full-width status row", () => {
  const topBarStart = source.indexOf("/* Top bar with sidebar toggle */");
  const topPanelStart = source.indexOf("/* Top panel dropdown — shared", topBarStart);
  assert.ok(topBarStart >= 0 && topPanelStart > topBarStart);
  const topBarSource = source.slice(topBarStart, topPanelStart);
  assert.match(topBarSource, /workspaceMode === "wall"[\s\S]*?<SessionWallToolbar/);
  assert.match(source, /availableHeight=\{wallViewport\.height\}/);
  assert.doesNotMatch(source, /data-global-status-bar="true"/);
  assert.doesNotMatch(source, /workspace\.wallStatus/);
});

test("normal mode stays independent of wall storage corruption", () => {
  const controllerStart = source.indexOf('data-normal-chat-controller="true"');
  const controllerEnd = source.indexOf(") : null : null}", controllerStart);
  assert.ok(controllerStart >= 0 && controllerEnd > controllerStart);
  const controllerSource = source.slice(controllerStart, controllerEnd);
  assert.doesNotMatch(controllerSource, /sessionWallHydrated|activeSessionWall/);
  assert.match(controllerSource, /display: workspacePreferenceHydrated && workspaceMode === "normal" \? "contents" : "none"/);
  assert.match(controllerSource, /workspacePreferenceHydrated \? showChat \? \(\s*<ChatWindow/);
  assert.match(source, /display: workspacePreferenceHydrated && sessionWallHydrated && workspaceMode === "wall" \? "flex" : "none"/);
});
