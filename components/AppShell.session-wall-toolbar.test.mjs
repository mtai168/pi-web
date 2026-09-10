import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * These are source-contract tests. This checkout has no approved client renderer
 * for AppShell, so they verify composition, identity, and callback wiring only;
 * they do not claim to run React effects, mount cleanup, or browser interaction.
 */
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const focusSource = await readFile(new URL("../hooks/useSessionWallFocus.ts", import.meta.url), "utf8");
const wallChatWindowSource = await readFile(new URL("./session-wall/SessionWallChatWindow.tsx", import.meta.url), "utf8");

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `${startText} not found`);
  assert.notEqual(end, -1, `${endText} not found after ${startText}`);
  return source.slice(start, end);
}

test("localizes the integrated Wall toolbar labels through the i18n workspace keys", async () => {
  const [en, zhCN, zhTW] = await Promise.all([
    readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8"),
  ]);
  const expected = {
    "workspace.wallLayout": ['"Layout"', '"布局"', '"版面配置"'],
    "workspace.wallManage": ['"Manage sessions"', '"管理会话"', '"管理工作階段"'],
    "workspace.wallRunning": ['"Running"', '"运行中"', '"執行中"'],
    "workspace.wallAttention": ['"Needs attention"', '"需要关注"', '"需要關注"'],
  };
  for (const [key, values] of Object.entries(expected)) {
    for (const [index, localeSource] of [en, zhCN, zhTW].entries()) {
      assert.match(localeSource, new RegExp(`"${key}": ${values[index]}`), `${key} in locale ${index}`);
    }
  }
  const toolbarSection = section("<SessionWallToolbar", "ariaLabel={translate(\"workspace.wall\")}");
  assert.match(toolbarSection, /labels=\{\{/);
  assert.match(toolbarSection, /layout: translate\("workspace\.wallLayout"\)/);
  assert.match(toolbarSection, /manage: translate\("workspace\.wallManage"\)/);
  assert.match(toolbarSection, /running: translate\("workspace\.wallRunning"\)/);
  assert.match(toolbarSection, /attention: translate\("workspace\.wallAttention"\)/);
  assert.match(toolbarSection, /productIdentity="Sausage Session Terminal"/);
  assert.match(toolbarSection, /productShortIdentity="SST"/);
  assert.match(source, /ariaLabel=\{translate\("workspace\.wall"\)\}/);
  assert.match(toolbarSection, /runningCount=\{activeSessionWall\?\.panes\.filter/);
  assert.match(toolbarSection, /attentionCount=\{wallAttentionCount\}/);
});

test("renders the existing Session Wall composition and management path", async () => {
  assert.match(source, /import \{ SessionWall \} from "\.\/session-wall\/SessionWall"/);
  assert.match(source, /import \{ SessionWallPicker \} from "\.\/session-wall\/SessionWallPicker"/);
  assert.match(source, /import \{ SessionWallToolbar \} from "\.\/session-wall\/SessionWallToolbar"/);
  assert.match(source, /<SessionWallToolbar[\s\S]*onLayoutChange=\{\(layout\) => dispatchSessionWallAction/);
  assert.match(source, /<SessionWall[\s\S]*getPaneMetadata=\{getSessionWallPaneMetadata\}[\s\S]*getPaneState=\{getSessionWallPaneState\}[\s\S]*renderPane=\{renderSessionWallPane\}/);
  assert.match(source, /<SessionWallPicker[\s\S]*sessions=\{sessionsWithSelection\}[\s\S]*onAddSession=\{handleWallAddSession\}[\s\S]*onReplaceSession=\{handleWallReplaceSession\}/);
  assert.match(source, /getPaneResetKey=\{\(pane\) => getSessionWallPaneRuntimeKey\(pane\)\}/);
  assert.match(source, /data-session-wall-placeholder="false"/);
  assert.doesNotMatch(source, /<div\s+data-session-wall-placeholder="true"/);

  const [sessionWallSource, pickerSource, toolbarSource] = await Promise.all([
    readFile(new URL("./session-wall/SessionWall.tsx", import.meta.url), "utf8"),
    readFile(new URL("./session-wall/SessionWallPicker.tsx", import.meta.url), "utf8"),
    readFile(new URL("./session-wall/SessionWallToolbar.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(sessionWallSource, /renderPane\?: \(context: SessionWallPaneRenderContext\)/);
  assert.match(pickerSource, /dispatchSessionWallSessionSelection/);
  assert.match(toolbarSource, /SESSION_WALL_LAYOUTS/);
  assert.match(toolbarSource, /\.wall-toolbar-layout-buttons\{display:inline-flex\}/);
  assert.match(toolbarSource, /@media \(max-width:760px\).*?\.wall-toolbar-layout-buttons\{display:none\}/);
  assert.match(toolbarSource, /@media \(max-width:680px\).*?\.wall-toolbar-layout-caption\{display:none\}/);
});

test("binds each Wall ChatWindow to immutable pane runtime identity", () => {
  const renderSource = section("const renderSessionWallPane", "const sidebarContent");
  assert.match(focusSource, /useLayoutEffect\(\(\) =>/);
  assert.match(focusSource, /guard\.advance\(nextIdentity\)/);
  assert.match(focusSource, /setSyncVersion/);
  assert.doesNotMatch(source, /wallFocus\.(advance|invalidate)\s*\(/);
  assert.match(source, /wallFocus\.capture\(getSessionWallFocusIdentity\(context\.pane\)\)/);
  assert.match(renderSource, /context\.focused/);
  assert.match(renderSource, /wallFocus\.accept\(token\)/);
  assert.match(renderSource, /<SessionWallChatWindow[\s\S]*key=\{context\.runtime\.runtimeKey\}/);
  assert.match(renderSource, /displayMode="wall-pane"/);
  assert.match(renderSource, /session=\{session\}/);
  assert.match(renderSource, /newSessionCwd=\{null\}/);
  assert.match(renderSource, /newSessionDraftKey=\{null\}/);
  assert.match(renderSource, /keyboardActive=\{acceptsToolbarReport\(\)\}/);
  assert.match(renderSource, /toolbarReportingActive=\{acceptsToolbarReport\(\)\}/);
  assert.match(renderSource, /onWallHeaderStatusChange=\{context\.onHeaderStatusChange\}/);
  assert.match(renderSource, /onRequestFocus=\{context\.onRequestFocus\}/);
  assert.doesNotMatch(renderSource, /chatInputRef|handleSend|handleAbort|selectedSession/);
  assert.match(source, /const clearWallToolbarState = useCallback/);
  assert.match(source, /setBranchTree\(\[\]\)/);
  assert.match(source, /setSystemPrompt\(null\)/);
  assert.match(source, /setSessionStats\(null\)/);
  assert.match(source, /setContextUsage\(null\)/);
});

test("routes focused toolbar reports and actions without an arbitrary normal fallback", () => {
  assert.match(source, /const toolbarSession = workspaceMode === "wall" \? focusedWallSession : selectedSession/);
  assert.match(source, /const activeToolbarSessionIdRef = useRef<string \| null>\(toolbarSession\?\.id \?\? null\)/);
  assert.match(source, /const wallToolbarOwnershipRef = useRef\(createSessionWallToolbarOwnership\(\)\)/);
  assert.match(source, /const \[, setWallToolbarOwnerRenderVersion\] = useState\(0\)/);
  assert.match(source, /setWallToolbarOwnerRenderVersion\(\(version\) => version \+ 1\)/);
  assert.match(source, /wallToolbarOwnershipRef\.current\.transition\(nextOwnerKey\)/);
  assert.match(source, /wallToolbarOwnershipRef\.current\.accepts\(capturedToolbarOwnerKey\)/);
  assert.match(source, /const wallToolbarReporterController = useMemo/);
  assert.match(source, /createSessionWallToolbarReporterController/);
  assert.match(source, /wallToolbarReporterController\.prune\(activeReporterKeys\)/);
  assert.doesNotMatch(source, /wallToolbarReportersRef|wallToolbarReporterRenderCycleRef|wallToolbarReporterGenerationRef|getWallToolbarReporter/);
  assert.match(source, /const activeReporterKeys = new Set<string>\(\)/);
  assert.match(source, /if \(workspaceMode === "wall" && activeSessionWall\)/);
  assert.match(source, /toolbarReporterController=\{wallToolbarReporterController\}/);
  assert.match(wallChatWindowSource, /toolbarReporterController\.create\(toolbarOwnerKey\)/);
  assert.match(wallChatWindowSource, /useLayoutEffect\(\(\) => \{[\s\S]*if \(!wallModeActive\)[\s\S]*reporter\.invalidate\(\)[\s\S]*reporter\.commit\(\)/);
  assert.match(wallChatWindowSource, /return \(\) => reporter\.invalidate\(\)/);
  assert.match(wallChatWindowSource, /toolbarReportingActive=\{toolbarReportingActive\}/);
  assert.match(wallChatWindowSource, /onSessionStatsChange=\{reporter\.onSessionStatsChange\}/);
  assert.match(wallChatWindowSource, /onContextUsageChange=\{reporter\.onContextUsageChange\}/);
  assert.match(source, /const isCurrentTarget = \(\) => \([\s\S]*?wallFocus\.accept\(focusToken\)/);
  assert.match(source, /onBranchDataChange=\{\(tree, activeLeafId, onLeafChange\) => \{[\s\S]*?if \(acceptsToolbarReport\(\)\) handleBranchDataChange/);
  assert.match(source, /onSystemPromptChange=\{\(prompt\) => \{[\s\S]*?if \(acceptsToolbarReport\(\)\) handleSystemPromptChange/);
  assert.match(source, /onSystemToolsChange=\{\(tools\) => \{[\s\S]*?if \(acceptsToolbarReport\(\)\) handleSystemToolsChange/);
  assert.match(source, /onSystemInfoLoaderChange=\{\(loader\) => \{[\s\S]*?if \(acceptsToolbarReport\(\)\) handleSystemInfoLoaderChange/);
  assert.match(source, /const handleWallSystemInfoToggle = useCallback/);
  assert.match(source, /const openWallSessionStatsPanel = useCallback/);
  assert.match(source, /if \(!toolbarSession\) return;/);
  assert.match(source, /disabled=\{!toolbarHasChat\}/);
  assert.match(source, /\/api\/sessions\/\$\{encodeURIComponent\(toolbarSession\.id\)\}\/export/);
  assert.match(source, /const ws = toolbarSession;/);
  assert.match(source, /selectedSessionId=\{toolbarSession\.id\}/);
});

test("preserves Wall source session and cwd through the existing file boundary", () => {
  const fileHandler = section("const handleOpenFile", "const handleOpenLinkedFile");
  const wallPane = section("const renderSessionWallPane", "const sidebarContent");
  assert.match(fileHandler, /sourceSessionId/);
  assert.match(fileHandler, /fileTabCwds/);
  assert.match(fileHandler, /sourceUsesExistingTabCwd/);
  assert.match(fileHandler, /if \(sourceSessionId\)/);
  assert.match(fileHandler, /delete next\[tabId\]/);
  assert.match(fileHandler, /sessionById\.get\(sourceSessionId\)\?\.cwd/);
  assert.match(wallPane, /onOpenFile=\{\(filePath\) => \{[\s\S]*?if \(!acceptsPaneCallback\(\)\) return;[\s\S]*?handleWallOpenFile\(session, filePath\);/);
  assert.match(source, /const handleWallOpenFile = useCallback\(\(session: SessionInfo, filePath: string\)/);
  assert.match(source, /handleOpenFile\(filePath, getFileName\(filePath\), \{ sourceSessionId: session\.id \}\)/);
  const viewerCwdSource = section("const activeFileViewerCwd", "const panelsVisible");
  const sourceBranch = viewerCwdSource.slice(viewerCwdSource.indexOf("?"), viewerCwdSource.lastIndexOf(": activeCwd"));
  assert.doesNotMatch(sourceBranch, /activeCwd/);
  assert.match(viewerCwdSource, /fileTabCwds\[activeFileTab\.id\] \?\? sessionById\.get\(activeFileTab\.sourceSessionId\)\?\.cwd/);
  assert.match(viewerCwdSource, /: activeCwd;/);
});

test("uses the existing Wall reducer/store and returns the focused pane to normal mode", () => {
  assert.match(source, /loadSessionWalls\(\)/);
  assert.match(source, /saveSessionWalls\(sessionWalls\)/);
  assert.match(source, /sessionWallReducer/);
  assert.match(source, /type: "setLayout"/);
  assert.match(source, /type: "add"/);
  assert.match(source, /type: "replace"/);
  assert.match(source, /type: "remove"/);
  assert.match(source, /type: "focus"/);
  assert.match(source, /const handleWallExpandPane = useCallback/);
  assert.match(source, /normalSessionToRestoreRef\.current = session/);
  assert.match(source, /handleWorkspaceModeChange\("normal"\)/);
  assert.match(source, /const target = normalSessionToRestoreRef\.current/);
  assert.match(source, /if \(selectedSession\?\.id !== target\.id\) handleSelectSession\(target\)/);
  assert.match(source, /useState<WorkspaceMode>\("normal"\)/);
  assert.match(source, /session=\{selectedSession\}/);
  assert.match(source, /onOpenFile=\{handleOpenLinkedFile\}/);
  assert.match(source, /sessionRunning=\{Boolean\(selectedSession && runningSessionIds\.has\(selectedSession\.id\)\)\}/);
});

test("reuses the single sidebar catalog source for Wall selection and refresh", () => {
  assert.match(source, /onSessionsChange=\{handleSessionsChange\}/);
  assert.match(source, /const handleSessionsChange = useCallback/);
  assert.match(source, /const handleWallRefresh = useCallback/);
  assert.match(source, /onCatalogRefreshStateChange=\{handleSessionWallRefreshState\}/);
  assert.match(source, /ownerRefreshKey=\{sessionWallRefreshKey\}/);
  assert.match(source, /onRefresh=\{handleWallRefresh\}/);
  assert.match(source, /setSessionWallRefreshKey\(\(key\) => key \+ 1\)/);
  assert.doesNotMatch(source, /sessionWallRefreshTimer/);
  assert.match(source, /workspaceMode === "wall"/);
  assert.match(source, /isMobile && workspaceMode !== "wall"/);
  assert.match(source, /workspaceMode === "wall" && !isMobile/);
  assert.doesNotMatch(source, /useSessionCatalog\(/);
});

test("measures the rendered Wall viewport instead of subtracting a fixed top-bar height", () => {
  assert.match(source, /const wallViewportRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /new ResizeObserver\(schedule\)/);
  assert.match(source, /requestAnimationFrame\(measure\)/);
  assert.match(source, /if \(rect\.width <= 0 \|\| rect\.height <= 0\)/);
  assert.match(source, /if \(frameId !== null\) window\.cancelAnimationFrame\(frameId\)/);
  assert.match(source, /sessionWallHydrated, workspaceMode, workspacePreferenceHydrated/);
  assert.match(source, /<div ref=\{wallViewportRef\} style=\{\{ position: "relative", flex: 1, minHeight: 0 \}\}>/);
  assert.match(source, /availableHeight=\{wallViewport\.height\}/);
  assert.doesNotMatch(source, /availableHeight=\{Math\.max\(0, wallViewport\.height - 36\)\}/);
});

test("rebinds only the originating Wall pane after a fork", () => {
  const forkHandler = section("const handleWallSessionForked", "const effectiveNewSessionCwd");
  const wallRender = section("const renderSessionWallPane", "const sidebarContent");

  assert.match(forkHandler, /useCallback\(\(pane: SessionWallPaneConfig, newSessionId: string\) => \{/);
  assert.match(forkHandler, /updateActiveSessionWall\(\(wall\) => \{/);
  assert.match(forkHandler, /const currentPane = wall\.panes\.find\(\(candidate\) => candidate\.paneId === pane\.paneId\)/);
  assert.match(forkHandler, /currentPane\.sessionId !== pane\.sessionId/);
  assert.match(forkHandler, /currentPane\.runtimeRevision \?\? 0\).*pane\.runtimeRevision \?\? 0/);
  assert.match(forkHandler, /sessionWallReducer\(wall, \{[\s\S]*?type: "replace"[\s\S]*?paneId: pane\.paneId[\s\S]*?sessionId: newSessionId[\s\S]*?updatedAt/);
  assert.match(forkHandler, /setRefreshKey\(\(key\) => key \+ 1\)/);
  assert.match(wallRender, /const capturedPane = context\.pane;/);
  assert.match(wallRender, /const capturedWallId = activeSessionWallId;/);
  assert.match(wallRender, /const capturedRuntimeKey = context\.runtime\.runtimeKey;/);
  assert.match(wallRender, /const acceptsPaneCallback = \(\) => acceptsWallPaneCallback\(\s*capturedPane,\s*capturedWallId,\s*capturedRuntimeKey,\s*\);/);
  assert.match(wallRender, /onSessionForked=\{\(newSessionId\) => \{[\s\S]*?if \(!acceptsPaneCallback\(\)\) return;[\s\S]*?handleWallSessionForked\(capturedPane, newSessionId\);/);
});

test("routes AgentSessionPanel selection through Wall focus or explicit normal-mode exit", () => {
  const wallSelection = section("const handleWallAgentSessionSelect", "const handleNewSession");
  assert.match(wallSelection, /if \(workspaceMode !== "wall" \|\| !activeSessionWall \|\| !session\.id\) return;/);
  assert.match(wallSelection, /const pane = activeSessionWall\.panes\.find\(\(candidate\) => candidate\.sessionId === session\.id\)/);
  assert.match(wallSelection, /if \(pane\) \{[\s\S]*?handleWallFocus\(pane\);[\s\S]*?return;/);
  assert.match(wallSelection, /normalSessionToRestoreRef\.current = session;[\s\S]*?handleWorkspaceModeChange\("normal"\)/);

  const agentsPanel = section(
    'activeTopPanel === "agents" && toolbarSessionFamily && toolbarSession && (',
    'activeTopPanel === "system"',
  );
  assert.match(agentsPanel, /workspaceMode !== "wall" &&[\s\S]*?onSelectSession=\{handleSelectSession\}/);
  assert.match(agentsPanel, /workspaceMode === "wall" &&[\s\S]*?onSelectSession=\{handleWallAgentSessionSelect\}/);
});

test("lets non-editable Wall Escape reach the global router while preserving local input handling", () => {
  const rootStart = source.indexOf("data-workspace-mode={workspaceMode}");
  const rootCaptureStart = source.indexOf("onKeyDownCapture={(event) => {", rootStart);
  const rootCaptureEnd = source.indexOf("\n      style={{", rootCaptureStart);
  assert.ok(rootStart >= 0 && rootCaptureStart > rootStart && rootCaptureEnd > rootCaptureStart);
  const rootCapture = source.slice(rootCaptureStart, rootCaptureEnd);

  assert.match(rootCapture, /if \(workspaceMode !== "wall" \|\| event\.key !== "Escape"\) return;/);
  assert.match(rootCapture, /tag === "TEXTAREA" \|\| tag === "INPUT" \|\| target\?\.isContentEditable/);
  assert.match(rootCapture, /event\.preventDefault\(\)/);
  assert.doesNotMatch(rootCapture, /event\.stopPropagation\(\)/);

  const mobileEscapeStart = source.indexOf("const handleKeyDown = (event: KeyboardEvent) => {");
  const mobileEscapeEnd = source.indexOf("\n\n    document.addEventListener", mobileEscapeStart);
  assert.ok(mobileEscapeStart >= 0 && mobileEscapeEnd > mobileEscapeStart);
  const mobileEscape = source.slice(mobileEscapeStart, mobileEscapeEnd);
  assert.match(source, /if \(!mobileToolbarMoreOpen\) return;/);
  assert.match(mobileEscape, /event\.key !== "Escape" \|\| workspaceMode === "wall"/);
  assert.match(mobileEscape, /tag === "TEXTAREA" \|\| tag === "INPUT" \|\| target\?\.isContentEditable/);
  assert.match(mobileEscape, /event\.preventDefault\(\)/);
  assert.match(mobileEscape, /event\.stopPropagation\(\)/);
  assert.match(source, /useGlobalKeyboardShortcuts\(\{/);
});
