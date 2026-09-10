import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const picker = await jiti.import("./SessionWallPicker.tsx");
const { SessionWallPicker, groupSessionWallSessions, normalizeSessionWallSearch,
  getSessionWallSessionTitle, getSessionWallOccupiedSessionIds, getSessionWallTargetSessionId,
  getSessionWallSelectionTargetSessionId, isSessionWallSessionSelectable, dispatchSessionWallSessionSelection,
  getSessionWallRefreshErrorMessage, runSessionWallRefresh, getSessionWallGroupId,
  getSessionWallGroupCollapsed, toggleSessionWallGroup, sessionWallSearchMatches,
} = picker;
const { SessionWallToolbar } = await jiti.import("./SessionWallToolbar.tsx");
const pickerSource = await readFile(new URL("./SessionWallPicker.tsx", import.meta.url), "utf8");
const toolbarSource = await readFile(new URL("./SessionWallToolbar.tsx", import.meta.url), "utf8");

function session(id, values = {}) {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: values.cwd ?? "/work/default", created: "2026-01-01T00:00:00.000Z",
    modified: values.modified ?? "2026-01-01T00:00:00.000Z", messageCount: 1,
    firstMessage: values.firstMessage ?? `first message ${id}`, name: values.name,
    projectRoot: values.projectRoot, projectKey: values.projectKey, branch: values.branch,
  };
}

function renderPicker(props = {}) {
  return renderToStaticMarkup(React.createElement(SessionWallPicker, {
    sessions: [], onAddSession() {}, ...props,
  }));
}

test("normalizes search and groups by stable project identity in catalog order", () => {
  const catalog = [
    session("a", { projectKey: "repo:a", projectRoot: "/work/a", name: "Alpha", branch: "feature/One" }),
    session("b", { projectKey: " repo:a ", projectRoot: "/work/a/other-worktree", name: "Beta" }),
    session("c", { projectKey: "repo:b", projectRoot: "/work/b", firstMessage: "Fix the flaky build" }),
  ];
  assert.equal(normalizeSessionWallSearch("  FIX\n  THE  BUILD  "), "fix the build");
  assert.deepEqual(groupSessionWallSessions(catalog).map((group) => [group.key, group.sessions.map(({ id }) => id)]), [
    ["repo:a", ["a", "b"]], ["repo:b", ["c"]],
  ]);
  assert.deepEqual(groupSessionWallSessions(catalog, "  FEATURE/ONE ").map((group) => group.sessions.map(({ id }) => id)), [["a"]]);
  assert.deepEqual(groupSessionWallSessions(catalog, "flaky build").map((group) => group.sessions.map(({ id }) => id)), [["c"]]);
  assert.deepEqual(groupSessionWallSessions(catalog, "no matching session"), []);
  assert.equal(getSessionWallSessionTitle(session("long", { firstMessage: "x".repeat(200) })).length, 96);
  assert.ok(getSessionWallSessionTitle(session("fallback", { firstMessage: "  useful   fallback  " })).startsWith("useful fallback"));
});

test("enforces Wall and external occupancy without duplicate selection", () => {
  const targetOnlyPanes = [{ paneId: "pane-a", sessionId: "session-a" }];
  const occupied = getSessionWallOccupiedSessionIds(targetOnlyPanes);
  assert.equal(getSessionWallTargetSessionId(targetOnlyPanes, "pane-a"), "session-a");
  assert.equal(getSessionWallSelectionTargetSessionId("replace", targetOnlyPanes, "pane-a", new Set()), "session-a");
  assert.equal(getSessionWallSelectionTargetSessionId("add", targetOnlyPanes, "pane-a", new Set()), null);

  const duplicatePanes = [
    ...targetOnlyPanes,
    { paneId: "pane-b", sessionId: "session-a" },
  ];
  const externalOccupancy = new Set(["session-a"]);
  assert.equal(getSessionWallSelectionTargetSessionId("replace", duplicatePanes, "pane-a", new Set()), null);
  assert.equal(getSessionWallSelectionTargetSessionId("replace", targetOnlyPanes, "pane-a", externalOccupancy), null);
  assert.equal(isSessionWallSessionSelectable("session-a", occupied), false);
  assert.equal(isSessionWallSessionSelectable("session-a", occupied, "session-a"), true);
  assert.equal(isSessionWallSessionSelectable("session-b", occupied, "session-a"), true);
  // Groups holding wall selections stay expanded so management stays reachable.
  const html = renderPicker({ sessions: [session("session-a")], occupiedSessionIds: ["session-a"] });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-session-id="session-a"/);
});

test("selection helper carries the exact session object and pane identity", () => {
  const selected = session("selected");
  const added = [];
  const replaced = [];
  assert.equal(dispatchSessionWallSessionSelection(selected, "add", "pane-b", new Set(), null, {
    onAddSession: (...args) => added.push(args),
  }), true);
  assert.equal(added[0][0], selected);
  assert.equal(added[0][0].id, "selected");
  assert.equal(added[0][1], "pane-b");

  assert.equal(dispatchSessionWallSessionSelection(selected, "replace", "pane-a", new Set(["selected"]), "selected", {
    onReplaceSession: (...args) => replaced.push(args),
  }), true);
  assert.equal(replaced[0][0], "pane-a");
  assert.equal(replaced[0][1], selected);

  assert.equal(dispatchSessionWallSessionSelection(selected, "add", "pane-b", new Set(["selected"]), null, {
    onAddSession: () => { throw new Error("duplicate selection"); },
  }), false);
});

test("refresh helper reports failures without rejecting and preserves callback identity", async () => {
  const refreshFailure = new Error("refresh failed");
  const refreshErrors = [];
  const failureMessage = await runSessionWallRefresh(
    async () => { throw refreshFailure; },
    (error) => refreshErrors.push(error),
  );
  assert.equal(failureMessage, "refresh failed");
  assert.deepEqual(refreshErrors, [refreshFailure]);
  assert.equal(await runSessionWallRefresh(async () => {}), null);
  assert.equal(await runSessionWallRefresh(async () => { throw "refresh failed"; }), "refresh failed");
  await assert.doesNotReject(runSessionWallRefresh(
    async () => { throw refreshFailure; },
    async () => { throw new Error("callback failed"); },
  ));
  assert.equal(getSessionWallRefreshErrorMessage({}), "Refresh failed");
});

test("renders loading, error/refresh, empty, and stale entry contracts", () => {
  assert.match(renderPicker({ loading: true }), /Loading sessions\.\.\./);
  assert.match(renderPicker({ loading: true, refreshing: true }), /Loading sessions\.\.\./);
  assert.match(renderPicker({ error: "catalog failed", onRefresh() {} }), /catalog failed/);
  assert.match(renderPicker({ error: "catalog failed", onRefresh() {} }), /Refresh sessions/);
  assert.match(renderPicker({ sessions: [] }), /No sessions available/);

  const html = renderPicker({
    sessions: [session("live", { projectKey: "repo:live", projectRoot: "/work/live" })],
    config: { panes: [{ paneId: "pane-stale", sessionId: "deleted-session" }] },
    onRequestReplace: (paneId) => paneId,
    onRemoveSession: (...args) => args,
  });
  assert.match(html, /Stale wall selections/);
  assert.match(html, /deleted-session/);
  assert.match(html, /pane-stale/);
  assert.match(html, /aria-label="Replace"/);
  assert.match(html, /aria-label="Remove"/);
});

test("keeps retained catalog visible while refresh progress is active", () => {
  const html = renderPicker({
    sessions: [session("retained", { projectKey: "repo:retained", projectRoot: "/work/retained", name: "Retained session" })],
    occupiedSessionIds: ["retained"],
    loading: true,
    refreshing: true,
  });
  assert.match(html, /Retained session/);
  assert.match(html, /Loading sessions\.\.\./);
  assert.match(html, /aria-busy="true"/);
});
test("keeps retained catalog selectable and reports an owner refresh failure", () => {
  const html = renderPicker({
    sessions: [session("retained", { projectKey: "repo:retained", projectRoot: "/work/retained", name: "Retained session" })],
    occupiedSessionIds: ["retained"],
    refreshError: "HTTP 503",
  });
  assert.match(html, /Retained session/);
  assert.match(html, /Refresh failed/);
  assert.match(html, /HTTP 503/);
  assert.doesNotMatch(html, /Stale wall selections/);
});

test("prefers supplied refresh lifecycle state over local compatibility feedback", () => {
  const html = renderPicker({
    sessions: [session("retained", { projectKey: "repo:retained", projectRoot: "/work/retained" })],
    refreshing: false,
    refreshDone: true,
    refreshError: null,
  });
  assert.match(html, /Sessions refreshed/);
  assert.match(pickerSource, /externalRefreshLifecycleProvided/);
  assert.match(pickerSource, /externalRefreshError \?\? null/);
  assert.match(pickerSource, /if \(externalRefreshLifecycleProvided\)/);
});

test("uses explicit named catalog body states instead of nested conditional rendering", () => {
  assert.match(pickerSource, /let catalogBody: ReactNode;/);
  assert.match(pickerSource, /if \(error && sessions\.length === 0\)/);
  assert.match(pickerSource, /else if \(\(loading \|\| refreshPending\) && sessions\.length === 0\)/);
  assert.match(pickerSource, /else if \(sessions\.length === 0\)/);
  assert.match(pickerSource, /else if \(groups\.length === 0\)/);
  assert.doesNotMatch(pickerSource, /error && sessions\.length === 0 \?/);
});

test("renders selected/running/attention metadata without exposing full message content", () => {
  const fullMessage = "secret preview ".repeat(30);
  const html = renderPicker({
    sessions: [session("running", {
      projectKey: "repo:ops", projectRoot: "/work/ops", name: "Deploy session", firstMessage: fullMessage,
      branch: "release/next", modified: "2026-02-01T00:00:00.000Z",
    })],
    runningSessionIds: ["running"], attentionSessionIds: ["running"],
    config: { panes: [{ paneId: "pane-1", sessionId: "running" }] },
    formatModified: () => "5 minutes ago",
  });
  // The group holds a selected/running/attention session, so it stays
  // expanded by default and the metadata is visible.
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Deploy session/);
  assert.match(html, /Branch: release\/next/);
  assert.match(html, /Modified: 5 minutes ago/);
  assert.match(html, /Running \| Needs attention/);
  assert.match(html, /aria-pressed="true"/);
  assert.doesNotMatch(html, new RegExp(fullMessage));
});

test("toolbar exposes controlled layouts, injected summaries, and accessible controls", () => {
  const html = renderToStaticMarkup(React.createElement(SessionWallToolbar, {
    layout: "2x4", runningCount: 7, attentionCount: 2, onLayoutChange() {}, onOpenManagement() {},
  }));
  assert.match(html, /data-session-wall-toolbar="true"/);
  assert.match(html, /aria-label="Layout"/);
  assert.match(html, /2x2/);
  assert.match(html, /2x4/);
  assert.match(html, /2x6/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Running: 7/);
  assert.match(html, /Needs attention: 2/);
  assert.match(html, /Manage sessions/);
});

test("components remain injected presentational UI with no runtime or product coupling", () => {
  for (const source of [pickerSource, toolbarSource]) {
    assert.doesNotMatch(source, /fetch\(|EventSource|setInterval|setTimeout|localStorage|useSessionCatalog|\/api\/sessions|AppShell|SessionSidebar|ChatWindow|useAgentSession/);
  }
  const pickerHtml = renderPicker();
  const toolbarHtml = renderToStaticMarkup(React.createElement(SessionWallToolbar, {
    layout: "2x2", runningCount: 0, attentionCount: 0, onLayoutChange() {}, onOpenManagement() {},
  }));
  assert.match(pickerHtml, /aria-modal="true"/);
  assert.match(pickerHtml, /focus-visible/);
  assert.match(toolbarHtml, /role="toolbar"/);
  assert.match(toolbarHtml, /aria-pressed=/);
});

test("group collapse defaults to collapsed for selection and toggles per group", () => {
  const empty = new Set();
  // No query: collapsed unless the user explicitly expanded the group or the
  // group carries selected/running/attention sessions (defaultExpanded).
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", empty, empty), true);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", new Set(["repo:a"]), empty), false);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", empty, empty, true), false);
  // Searching: matching groups stay expanded unless the user collapsed them.
  assert.equal(getSessionWallGroupCollapsed("repo:a", "brain", empty, empty), false);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "brain", empty, new Set(["repo:a"])), true);

  const expanded = toggleSessionWallGroup("repo:a", "", empty, empty);
  assert.equal(expanded.userExpandedKeys.has("repo:a"), true);
  assert.equal(expanded.userCollapsedKeys.has("repo:a"), false);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", expanded.userExpandedKeys, expanded.userCollapsedKeys), false);

  const collapsedAgain = toggleSessionWallGroup("repo:a", "", expanded.userExpandedKeys, expanded.userCollapsedKeys);
  assert.equal(collapsedAgain.userExpandedKeys.has("repo:a"), false);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", collapsedAgain.userExpandedKeys, collapsedAgain.userCollapsedKeys), true);

  const collapsedDuringSearch = toggleSessionWallGroup("repo:a", "brain", empty, empty);
  assert.equal(collapsedDuringSearch.userCollapsedKeys.has("repo:a"), true);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "brain", collapsedDuringSearch.userExpandedKeys, collapsedDuringSearch.userCollapsedKeys), true);
  // Clearing the search returns to the collapsed default unless expanded.
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", collapsedDuringSearch.userExpandedKeys, collapsedDuringSearch.userCollapsedKeys), true);
  // Whitespace-only input normalizes to an empty query: collapsed default.
  assert.equal(getSessionWallGroupCollapsed("repo:a", "   ", empty, empty), true);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "  brain  ", empty, empty), false);
  // An explicit user collapse wins over the active-group default expansion.
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", empty, empty, true), false);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", empty, new Set(["repo:a"]), true), true);
  assert.equal(getSessionWallGroupCollapsed("repo:a", "", new Set(["repo:a"]), new Set(["repo:a"]), true), false);
  assert.equal(getSessionWallGroupId("repo:a"), "session-wall-picker-group-repo%3Aa");
});

test("renders accessible expand/collapse controls with keyboard-native buttons", () => {
  const html = renderPicker({
    sessions: [
      session("a", { projectKey: "repo:a", projectRoot: "/work/a", name: "Alpha" }),
      session("b", { projectKey: "repo:b", projectRoot: "/work/b", name: "Beta" }),
    ],
  });
  // Collapsed groups expose aria-expanded but no aria-controls, because the
  // controlled region is not mounted until the group is expanded.
  assert.match(html, /<button type="button" aria-expanded="false" title="Expand group: \/work\/a"/);
  assert.match(html, /<button type="button" aria-expanded="false" title="Expand group: \/work\/b"/);
  assert.doesNotMatch(html, /aria-controls=/);
  assert.doesNotMatch(html, /data-session-id=/);
  assert.match(pickerSource, /aria-expanded=\{!collapsed\}/);
  assert.match(pickerSource, /aria-controls=\{collapsed \? undefined : groupId\}/);
  assert.match(pickerSource, /onClick=\{\(\) => toggleGroup\(group\.key, defaultExpanded\)\}/);
  assert.match(pickerSource, /getSessionWallGroupCollapsed\(group\.key, query, userExpandedKeys, userCollapsedKeys, defaultExpanded\)/);
});

test("search matches session name, first message, project, cwd, key, and branch case-insensitively", () => {
  const catalog = [
    session("name", { name: "Brainstorm session", projectKey: "repo:x", projectRoot: "/work/x" }),
    session("first", { firstMessage: "brain dump for the design", projectKey: "repo:x", projectRoot: "/work/x" }),
    session("project", { projectRoot: "/work/brain-lab", projectKey: "repo:y" }),
    session("cwd", { cwd: "/work/brain-tools", projectKey: "repo:z" }),
    session("key", { projectKey: "repo:brain-core", projectRoot: "/work/core" }),
    session("branch", { branch: "feature/brain-fix", projectKey: "repo:w", projectRoot: "/work/w" }),
    session("unrelated", { name: "Deploy pipeline", projectKey: "repo:v", projectRoot: "/work/v" }),
  ];
  const matches = groupSessionWallSessions(catalog, "brain");
  const matchedIds = matches.flatMap((group) => group.sessions.map(({ id }) => id));
  assert.deepEqual(matchedIds.sort(), ["branch", "cwd", "first", "key", "name", "project"].sort());
  assert.equal(sessionWallSearchMatches(catalog[0], "BRAIN"), true);
  assert.equal(sessionWallSearchMatches(catalog[0], "Brain"), true);
  assert.equal(sessionWallSearchMatches(catalog[6], "brain"), false);
  assert.equal(sessionWallSearchMatches(catalog[0], "  brain  "), true);
});
