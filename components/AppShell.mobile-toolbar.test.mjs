import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const mobileHookSource = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0, `missing section start: ${startText}`);
  assert.ok(end > start, `missing section end: ${endText}`);
  return source.slice(start, end);
}

test("keeps action icons inline in medium mobile sidebars", () => {
  assert.match(mobileHookSource, /NARROW_MOBILE_QUERY = "\(max-width: 480px\)"/);
  assert.match(source, /const isNarrowMobile = useIsNarrowMobile\(\);/);
  assert.match(source, /\{!isNarrowMobile && renderChatToolbarActions\(true\)\}/);
  assert.match(source, /\{isNarrowMobile && \([\s\S]*?data-mobile-toolbar-more="true"/);
});

test("uses a compact narrow-mobile toolbar with a floating action layer", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);
  assert.match(
    source,
    /data-mobile-toolbar-actions="true"[\s\S]*?position: "absolute"[\s\S]*?right: 0,[\s\S]*?left: TOP_BAR_ICON_BUTTON_SIZE/,
  );

  for (const action of ["history", "name", "agents", "branches", "system", "tools", "theme", "language"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher when the active session family has subagents", () => {
  const toolbarActions = section("const renderChatToolbarActions", "const renderSessionStatsButton");
  const agentsPanel = section(
    'activeTopPanel === "agents" && toolbarSessionFamily && toolbarSession && (',
    'activeTopPanel === "system"',
  );

  assert.match(source, /const toolbarSession = workspaceMode === "wall" \? focusedWallSession : selectedSession/);
  assert.match(source, /const hasSubagentSessions = Boolean\(toolbarSessionFamily\?\.subagents\.length\)/);
  assert.match(toolbarActions, /\{hasSubagentSessions && \(\s*<button[\s\S]*?toggleToolbarTopPanel\("agents", mobile\)/);
  assert.match(agentsPanel, /selectedSessionId=\{toolbarSession\.id\}/);
});

test("keeps the Agents panel open while switching sessions and positions it at the left", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents"\)[\s\S]*?left: topBarRect\.left[\s\S]*?width: Math\.min\(AGENT_PANEL_WIDTH, topBarRect\.width\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSelectSession\}/);
});

test("only renders branch toolbar controls for sessions with branches", () => {
  assert.match(source, /const sessionHasBranches = hasSessionBranches\(branchTree\)/);
  assert.match(source, /\{sessionHasBranches && \(mobile \? \(/);
  assert.match(source, /\{isMobile && sessionHasBranches && \(/);
  assert.match(source, /panel === "branches" \? null : panel/);
});

test("keeps covered statistics and file controls out of interaction and focus", () => {
  const statsButton = section("const renderSessionStatsButton", "const renderMainFileToggle");

  assert.match(statsButton, /const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;/);
  assert.match(statsButton, /disabled=\{!toolbarHasChat \|\| covered\}[\s\S]*?tabIndex=\{covered \? -1 : undefined\}/);
  assert.match(statsButton, /aria-hidden=\{covered \? true : undefined\}/);
  assert.match(statsButton, /visibility: covered \? "hidden" : "visible"/);
  assert.match(statsButton, /pointerEvents: covered \? "none" : "auto"/);

  const fileToggle = section("const renderMainFileToggle", "\n  return (\n    <>");
  assert.match(fileToggle, /data-mobile-toolbar-file=\{mobile \? "true" : undefined\}/);
  assert.match(fileToggle, /visibility: covered \? "hidden" : "visible"/);
  assert.match(fileToggle, /aria-hidden=\{covered \? true : undefined\}/);
});

test("closes the mobile action layer on outside click, Escape, layout changes, and session changes", () => {
  assert.match(source, /event\.composedPath\(\)\.includes\(toolbar\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?setMobileToolbarMoreOpen\(false\)/);
  assert.match(source, /\}, \[isMobile, isNarrowMobile, selectedSession\?\.id, newSessionDraftId\]\);/);
});

test("keeps the mobile action layer open after using an expanded action", () => {
  const toggleTopPanel = section("const toggleTopPanel = useCallback(", "const handleSystemInfoToggle");
  const themeHandler = section("const renderThemeButton", "const renderLanguageButton");
  const toolbarActions = section("const renderChatToolbarActions", "const renderSessionStatsButton");
  const languageButton = section("const renderLanguageButton", "const renderWorkspaceModeButton");
  const statsButton = section("const renderSessionStatsButton", "const renderMainFileToggle");

  for (const handler of [toggleTopPanel, themeHandler]) {
    assert.doesNotMatch(handler, /setMobileToolbarMoreOpen\(false\)/);
    assert.match(handler, /setMobileToolbarMoreOpen\(true\)/);
  }

  assert.match(source, /const toggleToolbarTopPanel = workspaceMode === "wall" \? toggleWallTopPanel : toggleTopPanel/);
  assert.match(toolbarActions, /handleViewFullHistory\(\);[\s\S]*?setMobileToolbarMoreOpen\(true\)/);
  assert.match(toolbarActions, /void handleAutoName\(\);[\s\S]*?setMobileToolbarMoreOpen\(true\)/);
  assert.match(toolbarActions, /toggleToolbarTopPanel\("branches", true\)/);
  assert.match(toolbarActions, /handleToolbarSystemInfoToggle\("system", mobile\)/);
  assert.match(toolbarActions, /handleToolbarSystemInfoToggle\("tools", mobile\)/);
  assert.match(languageButton, /onClick=\{\(\) => toggleTopPanel\("language", mobile\)\}/);
  assert.match(statsButton, /onClick=\{\(\) => toggleToolbarTopPanel\("session"\)\}/);
});

test("prioritizes context and cost when the mobile statistics area narrows", () => {
  assert.match(source, /\.mobile-session-stats \{[\s\S]*?container-type: inline-size/);
  assert.match(source, /@container \(max-width: 158px\)[\s\S]*?\.mobile-session-stat-io/);
  assert.match(source, /@container \(max-width: 88px\)[\s\S]*?\.mobile-session-stat-cost/);
  assert.match(source, /mobileContextText = percent !== null \? `\$\{percent\.toFixed\(0\)\}%` : null/);
});

test("places trust warnings below the mobile toolbar and the file toggle in toolbar flow", () => {
  assert.match(source, /\{isMobile && renderProjectTrustWarning\(true\)\}/);
  assert.match(source, /data-mobile-trust-banner=\{mobileBanner \? "true" : undefined\}/);
  assert.doesNotMatch(source, /File panel toggle — always visible at top-right/);
  assert.doesNotMatch(source, /position: "fixed", top: "env\(safe-area-inset-top\)"/);
});
