import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getSessionListIndices } = await jiti.import("./SessionSidebar.tsx");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const catalogSource = await readFile(new URL("../hooks/useSessionCatalog.ts", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("scrolling keeps the focused session and the viewport mounted without expanding the whole window", () => {
  for (const [scrollTop, focusedIndex] of [[0, 1999], [10000, 0]]) {
    const indices = getSessionListIndices(2000, scrollTop, 335, focusedIndex);
    const firstVisible = Math.floor(scrollTop / 54);
    const lastVisible = Math.ceil((scrollTop + 335) / 54) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(focusedIndex));
    assert.equal(indices.length, 24);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.equal(getSessionListIndices(2000, 0, 335, 3).length, 23);
  const blurred = getSessionListIndices(2000, 10000, 335);
  assert.equal(blurred.length, 23);
  assert.ok(!blurred.includes(0));
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(getSessionListIndices(5, 80000, 335, 1999), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 80000, 335, 1999), []);
  assert.equal(getSessionListIndices(2000, 0, 0).length, 28);
});

test("windows the session list to the measured viewport", () => {
  assert.match(source, /const SESSION_LIST_ITEM_HEIGHT = 54/);
  assert.match(source, /ref=\{listScrollRef\}/);
  assert.match(source, /onScroll=\{handleListScroll\}/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /height: sessionFamilies\.length \* SESSION_LIST_ITEM_HEIGHT/);
  assert.match(source, /top: index \* SESSION_LIST_ITEM_HEIGHT/);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(catalogSource, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(catalogSource, /fetcher\("\/api\/agent\/running"/);
  assert.match(catalogSource, /document\.visibilityState === "visible"/);
  assert.match(catalogSource, /document\.addEventListener\("visibilitychange", listener\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(catalogSource, /completionNotificationSuppressedSessionIds/);
  assert.match(
    catalogSource,
    /completedWithNotifications: completedInBackground\.filter\([\s\S]*?previousSuppressedCompletionSessionIds\.has\(id\)[\s\S]*?knownSubagentIds\.has\(id\)/,
  );
  assert.match(catalogSource, /transitions\.completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(catalogSource, /if \(transitions\.completedWithNotifications\.length > 0\) onBackgroundTaskDone\?\.\(\)/);
  assert.match(
    catalogSource,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("manual and lifecycle refreshes bypass the server session-list cache", () => {
  assert.match(catalogSource, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(catalogSource, /cache: "no-store"/);
  assert.match(catalogSource, /void refresh\(\{ showLoading: isFirst, force: !isFirst \}\)/);
  assert.match(catalogSource, /void refresh\(\{ force: true, background: true \}\);/);
});

test("cross-window version changes refresh the catalog without forcing a scan", () => {
  assert.match(
    catalogSource,
    /sessionListVersion: typeof value\.sessionListVersion === "number" \? value\.sessionListVersion : null/,
  );
  assert.match(
    catalogSource,
    /data\.sessionListVersion !== null && data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?refreshRef\.current\?\.\(\{ background: true \}\)/,
  );
});

test("replaces the manual refresh button with the session search toggle", () => {
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /title=\{t\("sidebar\.toggleSessionSearch"\)\}/);
});

test("session selection keeps cwd synchronization before navigation", () => {
  const selectionSource = source.slice(
    source.indexOf("const handleSelectSessionFromList"),
    source.indexOf("const handleNewSession", source.indexOf("const handleSelectSessionFromList")),
  );
  assert.match(selectionSource, /if \(s\.cwd\) setSelectedCwd\(s\.cwd\);\s*onSelectSession\(s, false, entryId, blockIndex\)/);
  assert.ok(
    selectionSource.indexOf("setSelectedCwd(s.cwd)")
      < selectionSource.indexOf("onSelectSession(s, false, entryId, blockIndex)"),
  );
  assert.match(source, /onClick=\{\(\) => handleSelectSessionFromList\(family\.root\)\}/);
});

test("search results jump through the same selection path with entry/block targets", () => {
  assert.match(source, /import \{ SessionSearch \} from "\.\/SessionSearch"/);
  assert.match(
    source,
    /<SessionSearch[\s\S]*?refreshKey=\{sessionListVersion\}[\s\S]*?onSelectSession=\{handleSelectSessionFromList\}/,
  );
  assert.match(source, /aria-controls="session-search-input"/);
  assert.match(source, /id="session-search-input"/);
});

test("offers the terminal opener only when the shell provides it", () => {
  assert.match(source, /onOpenTerminal\?: \(cwd: string\) => void/);
  assert.match(source, /\{onOpenTerminal && \(/);
  assert.match(source, /onClick=\{\(\) => onOpenTerminal\(selectedCwd \?\? selectedCwdProp!\)\}/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hovered && !session\.transient && \(/);
});

test("hides subagent rows and aggregates their state into the main session row", () => {
  assert.match(source, /const sessionFamilies = listSessionFamilies\(filteredSessions\)/);
  assert.match(source, /familySessions\.some\(\(session\) => session\.id === selectedSessionId\)/);
  assert.match(source, /familySessions\.some\(\(session\) => runningSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});
