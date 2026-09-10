import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  ExtensionStatusBar,
  formatExtensionStatusLine,
  sanitizeExtensionStatusText,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function renderStatusBar(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionStatusBar, props),
    ),
  );
}

test("sorts status text by hidden key like the Pi CLI footer", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "90-notify", text: "notify" },
    { key: "10-permissions", text: "permissions" },
    { key: "05-ponytail", text: "ponytail" },
  ];

  assert.equal(
    formatExtensionStatusLine(statuses),
    "ponytail permissions memory notify",
  );
});

test("preserves status line breaks while normalizing horizontal whitespace", () => {
  assert.equal(
    sanitizeExtensionStatusText("  first\tsecond \r\n third  "),
    "first second\nthird",
  );
});

test("allows multiline status text to wrap and scroll within the footer", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const statusLineRule = css.match(/\.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";
  const statusTextRule = css.match(/\.extension-status-text\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(statusLineRule, /max-height:/);
  assert.match(statusLineRule, /overflow-y:\s*auto/);
  assert.match(statusTextRule, /overflow-wrap:\s*anywhere/);
  assert.match(statusTextRule, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(statusTextRule, /text-overflow:\s*ellipsis/);
});

test("renders a single status line without identifier keys", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
      { key: "05-ponytail", text: "ponytail" },
    ],
  });

  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /extension-status-shelf/);
  assert.match(html, /extension-status-line/);
  assert.match(html, /extension-status-text/);
  assert.match(html, />ponytail <span style=/);
  assert.match(html, />memory</);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
});

test("compacts Wall status text into an accessible details surface without changing normal markup", () => {
  const html = renderStatusBar({
    wallPane: true,
    statuses: [{ key: "ponytail", text: "ponytail: FULL" }],
  });
  assert.match(html, /data-extension-status-wall="true"/);
  assert.match(html, /data-extension-status-details="true"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<div role="status"[^>]*wall-extension-status-line/);
  assert.match(html, /ponytail: FULL/);
  assert.match(globalCss, /\.wall-extension-status-inline\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(globalCss, /\.wall-extension-status-inline \.extension-widget-panels\s*\{[\s\S]*?flex:\s*1 1 100%/);
  assert.match(globalCss, /\.wall-composer-extension-status\s*\{[\s\S]*?overflow:\s*visible/);
  assert.doesNotMatch(html, /flex-wrap:nowrap/);
  assert.doesNotMatch(renderStatusBar({ statuses: [{ key: "status", text: "normal" }] }), /data-extension-status-wall/);
});
test("keeps Wall widgets and normal status in the bounded inline shelf", () => {
  const html = renderStatusBar({
    wallPane: true,
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{ key: "approval", lines: ["Approve"], placement: "aboveEditor" }],
  });

  assert.match(html, /extension-status-shelf wall-extension-status-inline has-widgets has-status/);
  assert.match(globalCss, /\.wall-extension-status-inline\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  assert.match(globalCss, /\.wall-extension-status-inline \.extension-widget-triggers\s*\{[\s\S]*?max-width:\s*70%/);
  assert.doesNotMatch(html, /flex-wrap:nowrap/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /data-extension-status-details="true"/);
  assert.match(html, /connected/);
});

test("keeps normal widgets and status in the shared footer", () => {
  const html = renderStatusBar({
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{ key: "usage", lines: ["42%"], placement: "aboveEditor" }],
  });

  assert.match(html, /extension-status-shelf has-widgets has-status/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /usage/);
  assert.match(html, /connected/);
});
