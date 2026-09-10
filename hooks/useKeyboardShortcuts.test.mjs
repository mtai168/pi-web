import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { handleGlobalKeyboardShortcut, registerAbortHandler } =
  await jiti.import("./useKeyboardShortcuts.ts");
const {
  clearSessionAction,
  focusSessionAction,
  registerSessionAction,
  resetSessionActions,
} = await jiti.import("../lib/session-wall/focus-actions.ts");

const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

afterEach(() => {
  resetSessionActions();
  registerAbortHandler(null);
});

function keyEvent(overrides = {}) {
  let prevented = false;
  return {
    key: "Escape",
    target: { tagName: "DIV" },
    ctrlKey: false,
    altKey: false,
    ...overrides,
    preventDefault() {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  };
}

function sessionAction(sessionId, calls) {
  return { sessionId, abort: () => calls.push(sessionId) };
}

test("Escape routes to the explicitly focused session", () => {
  const calls = [];
  const first = registerSessionAction(sessionAction("session-a", calls));
  const second = registerSessionAction(sessionAction("session-b", calls));

  assert.equal(focusSessionAction(first), true);
  const firstEvent = keyEvent();
  handleGlobalKeyboardShortcut(firstEvent);
  assert.equal(firstEvent.defaultPrevented, true);
  assert.deepEqual(calls, ["session-a"]);

  assert.equal(focusSessionAction(second), true);
  const secondEvent = keyEvent();
  handleGlobalKeyboardShortcut(secondEvent);
  assert.equal(secondEvent.defaultPrevented, true);
  assert.deepEqual(calls, ["session-a", "session-b"]);
});

test("unfocused routing falls back to legacy before and after final cleanup", () => {
  const calls = [];
  registerAbortHandler(() => calls.push("legacy"));
  const registration = registerSessionAction(sessionAction("session-a", calls));

  const beforeFocus = keyEvent();
  handleGlobalKeyboardShortcut(beforeFocus);
  assert.equal(beforeFocus.defaultPrevented, true);
  assert.deepEqual(calls, ["legacy"]);

  assert.equal(clearSessionAction(registration), true);
  const afterCleanup = keyEvent();
  handleGlobalKeyboardShortcut(afterCleanup);
  assert.equal(afterCleanup.defaultPrevented, true);
  assert.deepEqual(calls, ["legacy", "legacy"]);
});

test("focused callback failures do not escape the global keyboard path", () => {
  const registration = registerSessionAction({
    sessionId: "session-a",
    abort: () => { throw new Error("abort failed"); },
  });
  assert.equal(focusSessionAction(registration), true);

  const event = keyEvent();
  assert.doesNotThrow(() => handleGlobalKeyboardShortcut(event));
  assert.equal(event.defaultPrevented, true);
});

test("Escape in inputs remains available to local input handling", () => {
  const calls = [];
  const registration = registerSessionAction(sessionAction("session-a", calls));
  focusSessionAction(registration);

  for (const tagName of ["INPUT", "TEXTAREA"]) {
    const event = keyEvent({ target: { tagName } });
    handleGlobalKeyboardShortcut(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(calls, []);
});

test("Escape in contenteditable elements remains available to editor handling", () => {
  const calls = [];
  const registration = registerSessionAction(sessionAction("session-a", calls));
  focusSessionAction(registration);

  const event = keyEvent({ target: { tagName: "DIV", isContentEditable: true } });
  handleGlobalKeyboardShortcut(event);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test("normal mode keeps the legacy Escape and new-session contracts", () => {
  const aborts = [];
  registerAbortHandler(() => aborts.push("abort"));

  const escape = keyEvent();
  handleGlobalKeyboardShortcut(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(aborts, ["abort"]);

  let newSessionCwd = null;
  const newSession = keyEvent({ key: "n", ctrlKey: true, altKey: true });
  handleGlobalKeyboardShortcut(newSession, {
    activeCwd: "/work/project",
    onNewSession: (cwd) => { newSessionCwd = cwd; },
  });
  assert.equal(newSession.defaultPrevented, true);
  assert.equal(newSessionCwd, "/work/project");
});

test("existing callers retain their registration and global hook paths", () => {
  assert.match(chatWindowSource, /import \{ registerAbortHandler \} from "@\/hooks\/useKeyboardShortcuts"/);
  assert.match(chatWindowSource, /registerAbortHandler\(sessionBusy \? handleAbort : null\)/);
  assert.match(appShellSource, /import \{ useGlobalKeyboardShortcuts \} from "@\/hooks\/useKeyboardShortcuts"/);
  assert.match(appShellSource, /useGlobalKeyboardShortcuts\(\{/);
});
