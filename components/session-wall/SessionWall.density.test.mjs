import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SessionWallPane } = await jiti.import("./SessionWallPane.tsx");
const { ChatInput } = await jiti.import("../ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const globalsCss = await readFile(new URL("../../app/globals.css", import.meta.url), "utf8");
const paneSource = await readFile(new URL("./SessionWallPane.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("../ChatInput.tsx", import.meta.url), "utf8");
const messageViewSource = await readFile(new URL("../MessageView.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../ChatWindow.tsx", import.meta.url), "utf8");

function renderPane() {
  return renderToStaticMarkup(
    React.createElement(SessionWallPane, {
      pane: { paneId: "pane-a", sessionId: "session-a", runtimeRevision: 0 },
      renderContent: () => React.createElement("div", null, "transcript"),
    }),
  );
}

function renderNormalInput() {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false }),
    ),
  );
}

test("wall pane content carries the density scope; normal mode never does", () => {
  const wallHtml = renderPane();
  assert.match(wallHtml, /data-wall-density="true"/);
  assert.match(wallHtml, /role="log"/);
  // The density scope is the wall content wrapper only.
  assert.doesNotMatch(paneSource, /data-wall-density="true"[\s\S]{0,80}data-session-wall-pane/);
  const normalHtml = renderNormalInput();
  assert.doesNotMatch(normalHtml, /data-wall-density/);
  assert.doesNotMatch(chatInputSource, /data-wall-density/);
  assert.doesNotMatch(messageViewSource, /data-wall-density/);
  assert.doesNotMatch(chatWindowSource, /data-wall-density/);
});

test("density variables reduce typography and composer dimensions by ~33% with readable floors", () => {
  const densityBlock = globalsCss.slice(globalsCss.indexOf("[data-wall-density=\"true\"] {"));
  const blockEnd = densityBlock.indexOf("}", densityBlock.indexOf("--wall-btn-pad-h"));
  const block = densityBlock.slice(0, blockEnd + 1);
  assert.match(block, /--wall-font: 11px;/); // 14px body -> 11px (21% font, ~31% line box with 1.4)
  assert.match(block, /--wall-font-meta: 10px;/); // 11px metadata -> 10px readable floor
  assert.match(block, /--wall-line: 1\.4;/); // 1.6 -> 1.4
  assert.match(block, /--wall-msg-gap: 10px;/); // 16px -> 10px message spacing
  assert.match(block, /--wall-msg-pad: 6px 10px;/); // 8px 12px -> 6px 10px bubble padding
  assert.match(block, /--wall-pane-pad: 8px 10px;/); // 12px 14px -> 8px 10px pane wrapper
  assert.match(block, /--wall-composer-pad: 5px 6px 5px 10px;/); // 10px 10px 10px 14px
  assert.match(block, /--wall-composer-root-pad: 0 10px 4px;/); // 0 16px 8px
  assert.match(block, /--wall-composer-root-pad-right: 10px;/); // 52px minimap gutter -> 10px
  assert.match(block, /--wall-control-h: 24px;/); // 32px -> 24px focus-target floor
  assert.match(block, /--wall-gap: 4px;/); // 8px -> 4px
  assert.match(block, /--wall-textarea-min: 20px;/); // 24px -> 20px
  assert.match(block, /--wall-textarea-max: 160px;/); // 200px -> 160px
  assert.match(block, /--wall-btn-pad-v: 6px;/);
  assert.match(block, /--wall-btn-pad-h: 10px;/);
  // Composer vertical footprint: 12+8+10+24+10+8+32+8 = 112px -> 8+4+5+20+5+4+24+4 = 74px (~34%).
  // No viewport-scaled font sizes anywhere in the density scope.
  assert.doesNotMatch(block, /vw|vh|dvh|dvw/);
  // Markdown transcript text is scoped through the same variables.
  assert.match(globalsCss, /\[data-wall-density="true"\] \.markdown-body \{\s*font-size: var\(--wall-font\);\s*line-height: var\(--wall-line\);/);
});

test("normal-mode fallbacks keep Pi Web sizing untouched", () => {
  assert.match(chatInputSource, /fontSize: "var\(--wall-font, 14px\)"/);
  assert.match(chatInputSource, /lineHeight: "var\(--wall-line, 1\.6\)"/);
  assert.match(chatInputSource, /minHeight: compact \? 96 : "var\(--wall-textarea-min, 24px\)"/);
  assert.match(chatInputSource, /maxHeight: "var\(--wall-textarea-max, 200px\)"/);
  assert.match(chatInputSource, /padding: compact \? 0 : "var\(--wall-composer-pad, 10px 10px 10px 14px\)"/);
  assert.match(chatInputSource, /padding: compact \? 0 : "var\(--wall-composer-root-pad, 0 16px 8px\)"/);
  assert.match(chatInputSource, /paddingRight: composerRightPadding,/);
  assert.match(chatInputSource, /let composerRightPadding: string \| number = "var\(--wall-composer-root-pad-right, 52px\)";/);
  assert.match(chatInputSource, /height: "var\(--wall-control-h, 32px\)"/);
  assert.match(chatInputSource, /marginTop: wallPane \? 0 : "var\(--wall-gap, 8px\)"/);
  assert.match(messageViewSource, /marginBottom: "var\(--wall-msg-gap, 16px\)"/);
  assert.match(messageViewSource, /fontSize: "var\(--wall-font, 14px\)"/);
  assert.match(messageViewSource, /padding: "var\(--wall-msg-pad, 8px 12px\)"/);
  assert.match(messageViewSource, /fontSize: "var\(--wall-font-meta, 11px\)"/);
  assert.match(paneSource, /padding: "var\(--wall-pane-pad, 12px 14px\)"/);
  // The wall pane keeps its flex-fill layout: density never changes the pane
  // frame or the log wrapper's flex geometry.
  assert.match(paneSource, /flex: "1 1 auto", minWidth: 0, minHeight: 0, overflowY: "auto"/);
  assert.match(paneSource, /width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden"/);
});

test("wall pane transcript column tightens without touching normal column padding", () => {
  assert.match(chatWindowSource, /padding: `0 \$\{isWallPane \? 8 : CHAT_COLUMN_PADDING\}px`/);
  // The wall transcript clears the Brain status pill overlay.
  assert.match(chatWindowSource, /paddingTop: isWallPane \? 44 : undefined/);
  assert.match(chatWindowSource, /const CHAT_COLUMN_PADDING = 16;/);
});
