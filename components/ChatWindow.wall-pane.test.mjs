import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith("ChatMinimap.module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default { preview: \"preview\", turn: \"turn\", number: \"number\", content: \"content\", user: \"user\", userText: \"userText\", assistant: \"assistant\", assistantJump: \"assistantJump\", outline: \"outline\", heading: \"heading\", paragraph: \"paragraph\" };",
    };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const {
  ChatWindow,
  clearOwnedLegacyAbortHandler,
  registerActiveWallSessionAction,
  registerOwnedLegacyAbortHandler,
} = await jiti.import("./ChatWindow.tsx");
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const {
  clearSessionAction,
  focusSessionAction,
  getFocusedSessionAction,
  invokeFocusedSessionAction,
  isSessionActionRoutingEnabled,
  registerSessionAction,
  resetSessionActions,
} = await jiti.import("../lib/session-wall/focus-actions.ts");
const { handleGlobalKeyboardShortcut, registerAbortHandler } = await jiti.import("../hooks/useKeyboardShortcuts.ts");

function renderChatWindow(props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatWindow, {
        session: null,
        newSessionCwd: "/tmp/project",
        newSessionDraftKey: "draft",
        ...props,
      }),
    ),
  );
}

function escapeEvent() {
  let prevented = false;
  return {
    key: "Escape",
    target: { tagName: "DIV" },
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  };
}

afterEach(() => {
  resetSessionActions();
  registerAbortHandler(null);
});

test("server-renders default and wall pane paths without dropping the local input", () => {
  const normal = renderChatWindow();
  const wall = renderChatWindow({ displayMode: "wall-pane" });

  assert.match(normal, /class="relative flex h-full min-w-0 flex-col overflow-hidden"/);
  assert.match(normal, /class="w-full max-w-\[820px\]"/);
  assert.match(wall, /class="relative flex h-full min-w-0 flex-col overflow-hidden"/);
  assert.match(wall, /class="w-full"/);
  assert.match(wall, /right:0/);
  // Geometry pin: the wall Brain/notice stack is rendered as the first child
  // of the composer-excluding content container (relative flex min-h-0
  // flex-1 overflow-hidden), so its height 100% is bounded by the container
  // whose bottom edge ends above the composer.
  assert.match(wall, /class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"><div class="chat-brain-stack"/);
  assert.match(wall, /<textarea/);
});

test("omitted display mode keeps the normal ChatWindow path", () => {
  assert.match(source, /displayMode = "normal"/);
  assert.match(source, /if \(isWallPane \|\| !sessionBusy\) return;/);
  assert.match(source, /registerOwnedLegacyAbortHandler\(owner, sessionBusy, handleAbort\)/);
  assert.match(source, /return \(\) => clearOwnedLegacyAbortHandler\(registration\)/);
  assert.match(source, /className="relative flex h-full min-w-0 flex-col overflow-hidden"/);
  assert.match(source, /maxWidth: isWallPane \? undefined : 820/);
  assert.match(source, /<MessageView/);
  assert.match(source, /VISIBLE_PAGE_SIZE/);
  assert.match(source, /!isWallPane && <ExtensionStatusBar statuses=\{extensionStatuses\} widgets=\{extensionWidgets\} \/>/);
});

test("Wall extension status is lifted into a bounded header slot without an empty placeholder", () => {
  const wall = renderChatWindow({ displayMode: "wall-pane" });
  assert.doesNotMatch(wall, /data-session-wall-header-status/);
  assert.match(source, /onWallHeaderStatusChange\?: \(content: ReactNode \| null\) => void/);
  assert.match(source, /if \(!isWallPane \|\| !onWallHeaderStatusChange\) return;/);
  assert.match(source, /extensionStatuses\.length === 0 && extensionWidgets\.length === 0/);
  assert.match(source, /return \(\) => onWallHeaderStatusChange\(null\)/);
  assert.match(source, /data-session-wall-header-status="true"/);
  assert.match(source, /flex: "0 1 min\(36%, 220px\)"/);
  assert.match(source, /width: "min\(36%, 220px\)"/);
  assert.match(source, /height: 28/);
  assert.match(source, /<ExtensionStatusBar statuses=\{extensionStatuses\} widgets=\{extensionWidgets\} wallPane \/>/);
});

test("wall panes keep transcript and ChatInput while hiding the minimap and cap", () => {
  assert.match(source, /<ChatInput[\s\S]*?onSend=\{handleSend\}[\s\S]*?onAbort=\{handleAbort\}/);
  assert.match(source, /ref=\{scrollContainerRef\}\s+className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto/);
  assert.match(source, /<div ref=\{messageContentRef\}[^>]*style=\{\{ width: "100%", minWidth: 0, maxWidth: isWallPane \? undefined : 820, margin: isWallPane \? 0 : "0 auto" \}\}>/);
  assert.match(source, /\{isMobile \|\| isWallPane \|\| pendingScrollRestore \? null : \(\s*<ChatMinimap/);
  assert.match(source, /right: isMobile \? 0 : CHAT_MINIMAP_WIDTH/);
  assert.match(source, /\.\.\.NOTICE_LAYER_BASE_STYLE,\s*position: "relative",\s*right: 0,/);
});

test("pane interaction focuses the explicit session action and cleanup is instance-local", () => {
  assert.match(source, /onRequestFocus\?: \(\) => void/);
  assert.match(source, /onClick=\{isWallPane \? requestPaneFocus : undefined\}/);
  assert.match(source, /onFocusCapture=\{isWallPane \? requestPaneFocus : undefined\}/);
  assert.match(source, /if \(keyboardActive\) \{\s+const registration = wallActionRegistrationRef\.current;\s+if \(registration\) focusSessionAction\(registration\);/);
  assert.match(source, /if \(!isWallPane \|\| !keyboardActive \|\| !sessionBusy \|\| !session\?\.id\) return;/);
  assert.match(source, /registerActiveWallSessionAction\(keyboardActive, sessionBusy, session\.id, handleAbort\)/);
  assert.match(source, /focusSessionAction\(registration\)/);
  assert.match(source, /clearSessionAction\(registration\)/);

  const calls = [];
  const first = registerSessionAction({ sessionId: "session-a", abort: () => calls.push("session-a") });
  const second = registerSessionAction({ sessionId: "session-b", abort: () => calls.push("session-b") });
  assert.equal(focusSessionAction(first), true);
  assert.equal(invokeFocusedSessionAction(), true);
  assert.deepEqual(calls, ["session-a"]);
  assert.equal(clearSessionAction(first), true);
  assert.equal(getFocusedSessionAction(), null);
  assert.equal(focusSessionAction(second), true);
  assert.equal(invokeFocusedSessionAction(), true);
  assert.deepEqual(calls, ["session-a", "session-b"]);
});

test("toolbar reporting is guarded without changing local send and stop paths", () => {
  assert.match(source, /const shouldReportToolbar = !isWallPane \|\| toolbarReportingActive === true/);
  assert.match(source, /const shouldReportToolbarRef = useRef\(shouldReportToolbar\)/);
  for (const callback of [
    "onBranchDataChangeRef.current",
    "onSystemPromptChangeRef.current",
    "onSystemToolsChangeRef.current",
    "onSystemInfoLoaderChangeRef.current",
    "onSessionStatsPanelOpenRef.current",
    "onSessionStatsChangeRef.current",
    "onContextUsageChangeRef.current",
  ]) {
    assert.match(source, new RegExp(`if \\(!shouldReportToolbar \\|\\| shouldReportToolbarRef\\.current !== shouldReportToolbar\\) return;\\s+${callback}\\?\\.`));
  }
  assert.match(source, /reportSessionStatsChangeRef\.current\(null\)/);
  assert.match(source, /reportContextUsageChangeRef\.current\(null\)/);
  assert.match(source, /const trustedBrainStableStatus = brainStableStatus\?\.sessionId === session\?\.id/);
  assert.match(source, /sessionId: session\.id, snapshot/);
  assert.match(source, /if \(shouldReportToolbar\) \{[\s\S]*?reportSessionStatsChangeRef\.current\(sessionStatsRef\.current\)[\s\S]*?reportContextUsageChangeRef\.current\(contextUsageRef\.current\)/);
  assert.match(source, /onSessionStatsChangeRef\.current\?\.\(null\)/);
  assert.match(source, /onContextUsageChangeRef\.current\?\.\(null\)/);
  assert.match(source, /onSend=\{handleSend\}/);
  assert.match(source, /onAbort=\{handleAbort\}/);
  assert.doesNotMatch(source, /onSessionStatsChange\?\.\(null\)/);
  assert.doesNotMatch(source, /onContextUsageChange\?\.\(null\)/);
});

test("normal abort cleanup cannot clear a newer owner and re-registration remains live", () => {
  const calls = [];
  const firstOwner = {};
  const secondOwner = {};

  const firstRegistration = registerOwnedLegacyAbortHandler(firstOwner, true, () => calls.push("first"));
  clearOwnedLegacyAbortHandler(firstRegistration);
  const firstReregistration = registerOwnedLegacyAbortHandler(firstOwner, true, () => calls.push("first-reregistered"));
  const secondRegistration = registerOwnedLegacyAbortHandler(secondOwner, true, () => calls.push("second"));
  clearOwnedLegacyAbortHandler(firstReregistration);

  const event = escapeEvent();
  handleGlobalKeyboardShortcut(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ["second"]);

  clearOwnedLegacyAbortHandler(secondRegistration);
  const clearedEvent = escapeEvent();
  handleGlobalKeyboardShortcut(clearedEvent);
  assert.equal(clearedEvent.defaultPrevented, false);
});

test("newer normal cleanup restores an older live handler", () => {
  const calls = [];
  const olderRegistration = registerOwnedLegacyAbortHandler({}, true, () => calls.push("older"));
  const newerRegistration = registerOwnedLegacyAbortHandler({}, true, () => calls.push("newer"));

  clearOwnedLegacyAbortHandler(newerRegistration);
  const event = escapeEvent();
  handleGlobalKeyboardShortcut(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ["older"]);
  clearOwnedLegacyAbortHandler(olderRegistration);
});

test("wall action handoff waits for activation then focuses before global routing", () => {
  const calls = [];
  let keyboardActive = false;
  let sessionBusy = false;

  assert.equal(registerActiveWallSessionAction(keyboardActive, sessionBusy, "session-a", () => calls.push("session-a")), null);
  assert.equal(isSessionActionRoutingEnabled(), false);
  assert.equal(getFocusedSessionAction(), null);

  keyboardActive = true;
  assert.equal(registerActiveWallSessionAction(keyboardActive, sessionBusy, "session-a", () => calls.push("session-a")), null);
  assert.equal(isSessionActionRoutingEnabled(), false);

  sessionBusy = true;
  const registration = registerActiveWallSessionAction(keyboardActive, sessionBusy, "session-a", () => calls.push("session-a"));
  assert.ok(registration);
  assert.equal(getFocusedSessionAction()?.sessionId, "session-a");

  const event = escapeEvent();
  handleGlobalKeyboardShortcut(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, ["session-a"]);
  assert.equal(clearSessionAction(registration), true);
});

test("wall registration keeps cleanup local without adding a runtime path", () => {
  assert.match(source, /registerActiveWallSessionAction/);
  assert.match(source, /if \(!keyboardActive \|\| !sessionBusy \|\| !sessionId\) return null;/);
  assert.match(source, /onSend=\{handleSend\}/);
  assert.match(source, /onAbort=\{handleAbort\}/);
});

test("reports blocking extension UI through pane identity and clears on cleanup", () => {
  assert.match(source, /onBlockingAttentionChange\?: \(identity: BrainStatusPaneIdentity, blocking: boolean\) => void/);
  assert.match(source, /const blockingExtensionUi = extensionDialog !== null\s+\|\| \(extensionCustomUi !== null && extensionCustomUi\.closed !== true\)/);
  assert.match(source, /!isWallPane\s+\|\| !wallModeActive\s+\|\| !onBlockingAttentionChange/);
  assert.match(source, /brainWallId === undefined/);
  assert.match(source, /onBlockingAttentionChange\(identity, blockingExtensionUi\)/);
  assert.match(source, /return \(\) => onBlockingAttentionChange\(identity, false\)/);
  assert.match(source, /\[blockingExtensionUi, brainPaneId, brainRuntimeKey, brainSessionId, brainWallId, isWallPane, wallModeActive, onBlockingAttentionChange\]/);
  assert.match(source, /<ExtensionDialog[\s\S]*?onRespond=\{respondToExtensionUi\}/);
  assert.match(source, /onInput=\{sendExtensionCustomInput\}/);
});

test("re-enters blocking attention when wall mode activates with extension UI already open", () => {
  assert.match(source, /wallModeActive\?: boolean/);
  assert.match(source, /wallModeActive = false/);
  assert.match(source, /!isWallPane\s+\|\| !wallModeActive/);
  assert.match(source, /onBlockingAttentionChange\(identity, blockingExtensionUi\)/);
  assert.match(source, /return \(\) => onBlockingAttentionChange\(identity, false\)/);
  assert.match(source, /wallModeActive, onBlockingAttentionChange\]/);
  assert.doesNotMatch(source, /respondToExtensionUi\(/);
});

test("normal lazy history, scroll, notices, and extension contracts remain present", () => {
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /captureScrollDistance/);
  assert.match(source, /restoreScrollTop/);
  assert.match(source, /<NoticeShelf notices=\{notices\} floating onPauseChange=\{setNoticePaused\} \/>/);
  assert.match(source, /!isWallPane && <ExtensionStatusBar statuses=\{extensionStatuses\} widgets=\{extensionWidgets\} \/>/);
  assert.match(source, /handleEditContent/);
});

test("wall-pane runtime mount instrumentation is attached once and gated on wall mode", () => {
  assert.equal((source.match(/bumpSessionWallDiagnostic\("runtimeMounts"\)/g) ?? []).length, 1);
  assert.equal((source.match(/bumpSessionWallDiagnostic\("runtimeUnmounts"\)/g) ?? []).length, 1);
  assert.match(source, /if \(!isWallPane\) return;[\s\S]*?bumpSessionWallDiagnostic\("runtimeMounts"\)[\s\S]*?return \(\) => bumpSessionWallDiagnostic\("runtimeUnmounts"\)/);
});
