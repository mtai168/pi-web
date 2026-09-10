import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `${start} not found`);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return source.slice(from, to);
}

test("search-result selection sets the target before the same-session early return", () => {
  const body = section("const handleSelectSession = useCallback", "const handleWallAgentSessionSelect");
  assert.match(body, /const handleSelectSession = useCallback\(\(session: SessionInfo, isRestore = false, entryId\?: string, blockIndex\?: number\)/);
  const targetSet = body.indexOf("setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);");
  const earlyReturn = body.indexOf("if (!isRestore && selectedSession) {");
  assert.notEqual(targetSet, -1, "search target set not found");
  assert.notEqual(earlyReturn, -1, "same-session early return not found");
  assert.ok(targetSet < earlyReturn, "target must be set before the same-session early return");
});

test("search target clearing is identity-safe against stale completions", () => {
  const body = section("const handleSearchTargetHandled = useCallback", "const [explorerRefreshKey");
  assert.match(body, /setSearchTarget\(\(current\) => current === target \? null : current\);/);
});

test("normal chat restores per-session scroll with search navigation taking precedence", () => {
  const chat = section("searchTarget={searchTarget?.sessionId", "sessionRunning={Boolean");
  assert.match(chat, /searchTarget=\{searchTarget\?\.sessionId === selectedSession\?\.id \? searchTarget : null\}/);
  assert.match(chat, /onSearchTargetHandled=\{handleSearchTargetHandled\}/);
  assert.match(chat, /initialScrollPosition=\{selectedSession \? sessionScrollPositionsRef\.current\.get\(selectedSession\.id\) \?\? null : null\}/);
  assert.match(chat, /onScrollPositionChange=\{handleSessionScrollPositionChange\}/);
  // ChatWindow contract: a search target wins over the ordinary scroll restore.
  assert.match(chatWindowSource, /initialScrollPositionRef = useRef\(searchTarget \? null : initialScrollPosition \?\? null\)/);
  // Wall panes must not receive the normal-session scroll/search props.
  const wallPane = section("const renderSessionWallPane = useCallback", "const sidebarContent");
  assert.doesNotMatch(wallPane, /onScrollPositionChange|searchTarget/);
});

test("quote fork uses fork_branch with the source identity and delivers the prompt once", () => {
  const body = section("const handleAskInNewChat = useCallback", "const handleInitialRestoreDone");
  assert.match(body, /sendAgentCommand<\{ newSessionId\?: string \}>\(sourceSessionId, \{/);
  assert.match(body, /type: "fork_branch",\s+entryId: sourceEntryId,/);
  assert.match(body, /if \(!result\?\.newSessionId\) throw new Error\(translate\("chat\.quoteForkFailed"\)\);/);
  assert.match(body, /setPendingQuotePrompt\(\{ sessionId: result\.newSessionId, text: prompt \}\)/);
  assert.match(body, /handleSessionForked\(result\.newSessionId\);/);
  assert.doesNotMatch(body, /for \(|while \(|retry/i);
  const chat = section("searchTarget={searchTarget?.sessionId", "soundEnabled={soundEnabled}");
  assert.match(chat, /onAskInNewChat=\{handleAskInNewChat\}/);
  assert.match(chat, /initialPrompt=\{pendingQuotePrompt\?\.sessionId === selectedSession\?\.id \? pendingQuotePrompt\?\.text : undefined\}/);
  assert.match(chat, /onInitialPromptConsumed=\{\(\) => setPendingQuotePrompt\(null\)\}/);
  // Wall panes never fork through the normal-session callback.
  const wallPane = section("const renderSessionWallPane = useCallback", "const sidebarContent");
  assert.doesNotMatch(wallPane, /onAskInNewChat/);
});

test("drafts park on session/cwd transitions and restore stays behind the stale fence", () => {
  assert.match(source, /function parkedNewSessionDraftKey\(cwd: string\): string \{\s+return `parked-new:\$\{cwd\}`;\s+\}/);
  const cwdChange = section("const handleCwdChange = useCallback", "const handleSelectSession");
  assert.match(cwdChange, /rekeyDraft\(previousDraftKey, parkedNewSessionDraftKey\(currentFreshCwd\)\);/);
  assert.match(cwdChange, /rekeyDraft\(parkedNewSessionDraftKey\(cwd\), draftKey\);/);
  const select = section("const handleSelectSession = useCallback", "const handleWallAgentSessionSelect");
  assert.match(select, /rekeyDraft\(activeDraftKey, parkedNewSessionDraftKey\(activeDraftCwd\)\);/);
  const newSession = section("const handleNewSession = useCallback", "const hydrateSelectedSession");
  assert.match(newSession, /rekeyDraft\(parkedNewSessionDraftKey\(cwd\), draftKey\);/);
  const restore = section("const restoreWorkspaceContext = useCallback", "const handleCwdChange");
  assert.match(restore, /if \(token !== workspaceRestoreTokenRef\.current\) return; \/\/ stale switch/);
  const fence = restore.indexOf("token !== workspaceRestoreTokenRef.current");
  const park = restore.indexOf("rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(cwd))");
  assert.ok(fence < park, "draft parking must sit behind the stale-response fence");
});

test("terminal tabs reuse by cwd, persist to sessionStorage, and close/restart replace", () => {
  const open = section("const handleOpenTerminal = useCallback", "const handleTerminalClosed");
  // A tab already closing must never be reused: reopening the cwd during an
  // in-flight close must create/focus a live tab the pending callback cannot remove.
  assert.match(open, /terminalTabs\.find\(\(tab\) => tab\.cwd === cwd && !tab\.closing\)/);
  assert.match(open, /if \(!existing\) setTerminalTabs\(\(tabs\) => \[\.\.\.tabs, tab\]\);/);
  assert.match(open, /setActiveFileTabId\(tab\.id\);/);
  assert.match(open, /setRightPanelOpen\(true\);/);
  assert.match(open, /if \(isMobile\) setSidebarOpen\(false\);/);
  const closed = section("const handleTerminalClosed", "const handleCloseFileTab");
  // A restart completion must not append a replacement when a live tab for the
  // same cwd already exists (e.g. the user reopened it during the in-flight close).
  assert.match(closed, /const replacement = tab\.closing === "restart" && !tabs\.some\(\(t\) => t\.id !== tab\.id && t\.cwd === tab\.cwd && !t\.closing\) \? newTerminalTab\(tab\.cwd\) : null;/);
  assert.match(closed, /return tabs\.flatMap\(\(item\) => item\.id !== tab\.id \? \[item\] : replacement \? \[replacement\] : \[\]\);/);
  const close = section("const handleCloseFileTab = useCallback", "const handleViewFullHistory");
  assert.match(close, /if \(terminalTabs\.some\(\(tab\) => tab\.id === tabId\)\) \{/);
  assert.match(close, /closing: "close"/);
  const storage = section("const [terminalTabs, setTerminalTabs]", "const handleFileViewerStateChange");
  assert.match(storage, /restoreTerminalTabs\(window\.sessionStorage\.getItem\(TERMINAL_TABS_KEY\)\)/);
  assert.match(storage, /window\.sessionStorage\.setItem\(TERMINAL_TABS_KEY, JSON\.stringify/);
  assert.match(storage, /setTerminalsRestored\(true\);/);
  assert.match(source, /onOpenTerminal=\{handleOpenTerminal\}/);
  const content = section("{/* Only the active viewer", "</div>\n      </div>\n    </div>");
  assert.match(content, /terminalTabs\.map\(\(tab\) =>/);
  assert.match(content, /<TerminalPanel/);
  assert.match(content, /hidden=\{tab\.id !== effectiveActiveTabId\}/);
  // Async close completions must never select a removed tab: the effective
  // active id is derived from the live lists, and the panel closes when empty.
  assert.match(source, /const effectiveActiveTabId = activeFileTabId !== null/);
  assert.match(source, /if \(rightPanelOpen && fileTabs\.length === 0 && terminalTabs\.length === 0\) setRightPanelOpen\(false\);/);
  assert.match(section("const handleTerminalClosed", "const handleCloseFileTab"), /setActiveFileTabId\(\(current\) => current !== tab\.id \? current : null\);/);
});
