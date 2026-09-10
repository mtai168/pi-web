import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ChatInput, getRuntimeSettingsPosition } = await jiti.import("./ChatInput.tsx");
const { clearDraft, getDraft, rekeyDraft, setDraft } = await jiti.import("@/lib/draft-store.ts");
const {
  SessionWallPane,
  getSessionWallPaneRuntimeKey,
} = await jiti.import("./session-wall/SessionWallPane.tsx");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const paneSource = await readFile(new URL("./session-wall/SessionWallPane.tsx", import.meta.url), "utf8");
const localeSources = await Promise.all(["en", "zh-CN", "zh-TW"].map((locale) => readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8")));

const draftKeys = ["wall-runtime-a", "wall-runtime-b", "wall-runtime-c"];

afterEach(() => {
  draftKeys.forEach(clearDraft);
});

function renderInputs(firstDraftKey, secondDraftKey) {
  const props = (draftKey) => ({
    draftKey,
    onSend() {},
    onAbort() {},
    isStreaming: false,
  });
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement("div", null,
        React.createElement(ChatInput, props(firstDraftKey)),
        React.createElement(ChatInput, props(secondDraftKey)),
      ),
    ),
  );
}

test("uses pane/session/revision as the immutable runtime identity", () => {
  const pane = { paneId: "pane-a", sessionId: "session-a", runtimeRevision: 3 };
  assert.equal(getSessionWallPaneRuntimeKey(pane), '["pane-a","session-a",3]');
  assert.notEqual(
    getSessionWallPaneRuntimeKey(pane),
    getSessionWallPaneRuntimeKey({ ...pane, sessionId: "session-b" }),
  );
  assert.notEqual(
    getSessionWallPaneRuntimeKey(pane),
    getSessionWallPaneRuntimeKey({ ...pane, paneId: "pane-b" }),
  );
  assert.notEqual(
    getSessionWallPaneRuntimeKey(pane),
    getSessionWallPaneRuntimeKey({ ...pane, runtimeRevision: 4 }),
  );
  assert.equal(getSessionWallPaneRuntimeKey({ paneId: "pane-a", sessionId: null }), '["pane-a",null,0]');
});

test("injects one focus-only runtime context without owning Send or Stop", () => {
  const pane = { paneId: "pane-a", sessionId: "session-a", runtimeRevision: 2 };
  let context;
  let focusCalls = 0;
  const html = renderToStaticMarkup(
    React.createElement(SessionWallPane, {
      pane,
      onFocus: () => { focusCalls += 1; },
      renderContent: (nextContext) => {
        context = nextContext;
        return React.createElement("output", {
          "data-runtime-key": nextContext.runtime.runtimeKey,
        }, nextContext.runtime.sessionId);
      },
    }),
  );

  assert.equal(context.runtime.paneId, "pane-a");
  assert.equal(context.runtime.sessionId, "session-a");
  assert.equal(context.runtime.runtimeKey, '["pane-a","session-a",2]');
  assert.equal(context.runtime.onRequestFocus, context.onRequestFocus);
  context.runtime.onRequestFocus();
  assert.equal(focusCalls, 1);
  assert.match(html, /data-runtime-key="\[&quot;pane-a&quot;,&quot;session-a&quot;,2\]"/);
  assert.match(html, />session-a<\/output>/);
  assert.doesNotMatch(paneSource, /ChatWindow|useAgentSession|selectedSession/);
});

// SSR covers initial input markup only; the pure draft-store contract covers replacement without an approved client renderer.
test("SSR initializes each ChatInput from its own draft key; store rekey stays isolated", () => {
  setDraft(draftKeys[0], { value: "draft A", images: [] });
  setDraft(draftKeys[1], { value: "draft B", images: [] });

  const html = renderInputs(draftKeys[0], draftKeys[1]);
  assert.match(html, />draft A<\/textarea>/);
  assert.match(html, />draft B<\/textarea>/);
  assert.deepEqual(getDraft(draftKeys[0]), { value: "draft A", images: [] });
  assert.deepEqual(getDraft(draftKeys[1]), { value: "draft B", images: [] });

  assert.match(chatInputSource, /const moved = rekeyStoredDraft\(previousKey, nextKey, currentDraft\)/);
  assert.deepEqual(rekeyDraft(draftKeys[0], draftKeys[2]), { value: "draft A", images: [] });
  assert.equal(getDraft(draftKeys[0]), null);
  assert.deepEqual(getDraft(draftKeys[1]), { value: "draft B", images: [] });
  assert.deepEqual(getDraft(draftKeys[2]), { value: "draft A", images: [] });
});

test("keeps the normal ChatInput contract injected through callbacks", () => {
  assert.match(chatInputSource, /onSend: \(message: string, images\?: AttachedImage\[\]\) => void/);
  assert.match(chatInputSource, /onAbort: \(\) => void/);
  assert.match(chatInputSource, /draftKey\?: string/);
  assert.match(chatInputSource, /const \[value, setValue\] = useState\(\(\) => \(draftKey \? getDraft\(draftKey\)/);
  assert.match(chatInputSource, /onSend\(msg, attachedImages\.length \? attachedImages : undefined\)/);
  assert.match(chatInputSource, /onAbort\(\)/);
  assert.doesNotMatch(chatInputSource, /wall-pane|selectedSession/);
});

// SSR verifies only markup and renderContent injection; client effects and mount cleanup require a renderer.
test("Wall composer keeps the editor dominant and summarizes runtime choices in one control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        wallPane: true,
        onSend() {},
        onAbort() {},
        isStreaming: false,
        model: { provider: "test", modelId: "model-1" },
        modelList: [{ provider: "test", id: "model-1", name: "Model One" }],
        onModelChange() {},
        thinkingLevel: "high",
        onThinkingLevelChange() {},
        toolPreset: "full",
        onToolPresetChange() {},
      }),
    ),
  );
  assert.match(html, /data-runtime-settings-summary="true"[^>]*>Model One · High reasoning · All tools<\/span>/);
  assert.doesNotMatch(html, /data-runtime-settings-summary="true"[^>]*>[^<]*default/);
  assert.match(chatInputSource, /wallPane\?: boolean/);
  assert.match(chatInputSource, /maxWidth: wallPane \? "none" : 820/);
  assert.match(chatInputSource, /flex: wallPane \? "2 1 0" : undefined/);
  assert.match(chatInputSource, /flexWrap: wallPane \? "wrap" : undefined/);
  assert.match(chatInputSource, /const wallNoticeStyle = wallPane \? \{ flex: "1 1 100%", minWidth: 0 \} : undefined/);
  assert.match(chatInputSource, /rawToolPresetLabel === "default" \? null : runtimeToolPresetLabel/);
  assert.doesNotMatch(chatInputSource, /wallPane && <style>/);
  assert.match(chatInputSource, /className=\{wallPane \? "wall-composer" : undefined\}/);
  assert.match(chatInputSource, /runtimeSettingsOpen/);
  assert.match(chatInputSource, /!wallPane && !isStreaming && onThinkingLevelChange/);
});
test("localizes automatic/loading/unknown runtime summaries and preset labels", () => {
  for (const messages of localeSources) {
    for (const key of ["chat.runtimeAutomatic", "chat.runtimeLoading", "chat.runtimeUnknown", "chat.toolPresetReadOnly", "chat.toolPresetDefault", "chat.toolPresetFull"]) {
      assert.match(messages, new RegExp(`"${key}":`));
    }
  }
  assert.match(chatInputSource, /if \(isAutoModelSelection\) return t\("chat\.runtimeAutomatic"\)/);
  assert.match(chatInputSource, /if \(modelSwitching \|\| \(!modelError && modelOptions\.length === 0\)\) return t\("chat\.runtimeLoading"\)/);
  assert.match(chatInputSource, /return t\("chat\.runtimeUnknown"\)/);
  assert.doesNotMatch(chatInputSource, /: "auto";/);
  assert.match(chatInputSource, /rawToolPresetLabel === "default" \? null : runtimeToolPresetLabel/);
});

test("Wall composer leaves extension status to the pane header", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        wallPane: true,
        onSend() {},
        onAbort() {},
        isStreaming: false,
        extensionStatuses: [{ key: "ponytail", text: "ponytail: FULL" }],
        extensionWidgets: [{ key: "approval", lines: ["Approve"], placement: "aboveEditor" }],
      }),
    ),
  );
  assert.doesNotMatch(html, /data-extension-status-wall/);
  assert.doesNotMatch(html, /ponytail: FULL|approval/);
  assert.doesNotMatch(chatInputSource, /ExtensionStatusBar|extensionStatuses|extensionWidgets|wall-composer-extension-status/);
  assert.match(chatInputSource, /!wallPane && !isStreaming && onCompact/);
  assert.match(chatInputSource, /!wallPane && onSoundToggle !== undefined/);
});

test("Wall runtime settings contain session controls while normal controls stay separate", () => {
  assert.match(chatInputSource, /wallPane && \(onModelChange \|\| onThinkingLevelChange \|\| onToolPresetChange \|\| onCompact \|\| onSoundToggle !== undefined\)/);
  assert.match(chatInputSource, /role="separator" aria-orientation="horizontal"/);
  assert.match(chatInputSource, /\{\(!isStreaming \|\| isCompacting\) && onCompact && \(/);
  assert.match(chatInputSource, /onClick=\{isCompacting \? onAbortCompaction : onCompact\}/);
  assert.match(chatInputSource, /title=\{isCompacting \? t\("chat\.stopCompaction"\) : t\("chat\.compactContext"\)\}/);
  assert.match(chatInputSource, /onClick=\{onSoundToggle\}/);
  assert.match(chatInputSource, /aria-pressed=\{soundEnabled\}/);
  assert.doesNotMatch(chatInputSource, /wallPane && !isStreaming && \(onModelChange \|\| onThinkingLevelChange \|\| onToolPresetChange\)/);
  assert.doesNotMatch(chatInputSource, /if \(isStreaming && runtimeSettingsOpen\)/);
});

test("Wall runtime settings use a labeled dialog and return focus on Escape", () => {
  assert.match(chatInputSource, /aria-haspopup="dialog"/);
  assert.match(chatInputSource, /role="dialog"[^>]*aria-modal=\{false\}[^>]*aria-label=\{t\("chat\.runtimeSettings"\)\}/);
  assert.match(chatInputSource, /document\.addEventListener\("keydown", handleKeyDown, true\)/);
  assert.match(chatInputSource, /const target = event\.target instanceof Element \? event\.target : null/);
  assert.match(chatInputSource, /target\?\.closest\('\[role="listbox"\]'\)/);
  assert.match(chatInputSource, /const otherDialog = target\?\.closest/);
  assert.match(chatInputSource, /runtimeSettingsPanelRef/);
  assert.match(chatInputSource, /firstControl/);
  assert.match(chatInputSource, /closeRuntimeSettings/);
  assert.match(chatInputSource, /variant="field" placement="auto" ariaLabel=\{t\("chat\.runtimeModel"\)\}/);
  assert.doesNotMatch(chatInputSource, /role="menu" aria-label=\{t\("chat\.runtimeSettings"\)\}/);
});

test("normal mode keeps standalone compact and sound controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        onCompact() {},
        soundEnabled: true,
        onSoundToggle() {},
      }),
    ),
  );
  assert.match(html, /aria-label="Compact context"/);
  assert.match(html, /aria-label="Disable completion sound"/);
  assert.doesNotMatch(html, /data-runtime-settings-summary/);
});

test("runtime settings geometry honors visual viewport offsets and never opens at zero height", () => {
  const above = getRuntimeSettingsPosition(
    { top: 520, right: 1180, bottom: 552 },
    { width: 1280, height: 800, offsetLeft: 10, offsetTop: 20 },
  );
  assert.ok(above);
  assert.ok(above.maxHeight >= 128);
  assert.ok(above.top >= 36);
  assert.ok(above.left >= 26);
  const offsetAbove = getRuntimeSettingsPosition(
    { top: 520, right: 1180, bottom: 552 },
    { width: 1280, height: 800, offsetLeft: 10, offsetTop: 20 },
  );
  const layoutViewportAbove = getRuntimeSettingsPosition(
    { top: 540, right: 1190, bottom: 572 },
    { width: 1280, height: 800 },
  );
  assert.ok(offsetAbove && layoutViewportAbove);
  assert.equal(offsetAbove.top, layoutViewportAbove.top);
  assert.equal(offsetAbove.left, layoutViewportAbove.left);

  const below = getRuntimeSettingsPosition(
    { top: 40, right: 240, bottom: 72 },
    { width: 400, height: 320, offsetLeft: 12, offsetTop: 18 },
  );
  assert.ok(below);
  assert.ok(below.maxHeight >= 128);
  assert.ok(below.top >= 78);

  const clamped = getRuntimeSettingsPosition(
    { top: -80, right: 300, bottom: -48 },
    { width: 400, height: 320, offsetLeft: 0, offsetTop: 0 },
  );
  assert.ok(clamped);
  assert.equal(clamped.top, 16);
  assert.ok(clamped.top + clamped.maxHeight <= 304);

  assert.equal(
    getRuntimeSettingsPosition(
      { top: 90, right: 200, bottom: 122 },
      { width: 240, height: 180, offsetLeft: 0, offsetTop: 0 },
    ),
    null,
  );
  assert.match(chatInputSource, /viewport\?\.width/);
  assert.match(chatInputSource, /visualViewport\?\.offsetTop/);
  assert.match(chatInputSource, /window\.requestAnimationFrame\(update\)/);
  assert.match(chatInputSource, /window\.cancelAnimationFrame\(frameId\)/);
});


test("SSR keeps an unkeyed normal ChatInput usable", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
      }),
    ),
  );
  assert.match(html, /<textarea/);
  assert.match(html, />Send<\/button>/);
});
