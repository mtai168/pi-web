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
  DEFAULT_EXPANDED_WIDGET_LINES,
  ExtensionWidgets,
  formatExtensionWidgetContent,
  getNextExpandedWidgetKey,
  getUpdatedExtensionWidgetKeys,
  getWidgetPanelPosition,
  snapshotExtensionWidgetContents,
} = await jiti.import("./ExtensionWidgets.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const widgetsSource = await readFile(new URL("./ExtensionWidgets.tsx", import.meta.url), "utf8");

test("Wall widget expansion uses a bounded portal with explicit focus dismissal", () => {
  assert.match(widgetsSource, /wallPane\?: boolean/);
  assert.match(widgetsSource, /createPortal\(expandedPanel, document\.body\)/);
  assert.match(widgetsSource, /window\.visualViewport\?\.addEventListener\("scroll", schedule\)/);
  assert.match(widgetsSource, /role=\{wallPane \? "dialog" : undefined\}/);
  assert.match(widgetsSource, /tabIndex=\{wallPane \? -1 : undefined\}/);
  assert.match(widgetsSource, /if \(expandedWidgetKey && !expandedWidget\) setExpandedWidgetKey\(null\)/);
  assert.match(widgetsSource, /\(firstControl \?\? panel\)\.focus\(\)/);
  assert.match(widgetsSource, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(widgetsSource, /event\.key !== "Escape"/);
  const dismissalSource = widgetsSource.slice(
    widgetsSource.indexOf("const expandedKey = expandedWidget.key"),
    widgetsSource.indexOf('document.addEventListener("pointerdown", handlePointerDown, true)'),
  );
  assert.match(dismissalSource, /triggerRefs\.current\.get\(expandedKey\)/);
  assert.match(dismissalSource, /if \(!ownedByWidget\) return/);
  const pointerHandler = widgetsSource.slice(
    widgetsSource.indexOf("const handlePointerDown"),
    widgetsSource.indexOf("const handleKeyDown"),
  );
  assert.doesNotMatch(pointerHandler, /preventDefault/);
});

test("widget portal geometry stays inside the visual viewport for offscreen triggers", () => {
  const position = getWidgetPanelPosition(
    { top: -80, right: 300, bottom: -48 },
    { width: 400, height: 320, offsetLeft: 0, offsetTop: 0 },
  );
  assert.ok(position);
  assert.equal(position.top, 8);
  assert.ok(position.top + position.maxHeight <= 312);
  const offsetPosition = getWidgetPanelPosition(
    { top: 100, right: 300, bottom: 132 },
    { width: 400, height: 320, offsetLeft: 12, offsetTop: 20 },
  );
  const layoutPosition = getWidgetPanelPosition(
    { top: 120, right: 312, bottom: 152 },
    { width: 400, height: 320 },
  );
  assert.ok(offsetPosition && layoutPosition);
  assert.equal(offsetPosition.top, layoutPosition.top);
  assert.equal(offsetPosition.left, layoutPosition.left + 12);
  const fallback = getWidgetPanelPosition(
    { top: 70, right: 300, bottom: 102 },
    { width: 400, height: 160 },
  );
  assert.ok(fallback);
  assert.equal(fallback.top, 8);
  assert.ok(fallback.maxHeight >= 72);
});

function renderWidgets(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionWidgets, props),
    ),
  );
}

test("renders short extension widgets without a truncation marker", () => {
  const html = renderWidgets({
    widgets: [{ key: "short", lines: ["first", "second"], placement: "aboveEditor" }],
  });

  assert.match(html, /first\nsecond/);
  assert.doesNotMatch(html, /widget truncated/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-direction="up"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
});

test("collapses long widgets by default", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "long", lines, placement: "belowEditor" }],
  });

  assert.ok(lines.length > DEFAULT_EXPANDED_WIDGET_LINES);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /<pre/);
  assert.doesNotMatch(html, /line-1/);
  assert.doesNotMatch(html, /line-10/);
  assert.doesNotMatch(html, /line-12/);
});

test("keeps all widget lines available for the scrollable expanded panel", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const content = formatExtensionWidgetContent(lines);

  assert.match(content, /line-10/);
  assert.match(content, /line-12/);
  assert.doesNotMatch(content, /widget truncated/);
});

test("keeps compact widgets expanded by default", () => {
  const lines = Array.from(
    { length: DEFAULT_EXPANDED_WIDGET_LINES },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "compact", lines, placement: "aboveEditor" }],
  });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<pre/);
});

test("expands at most one compact widget", () => {
  const html = renderWidgets({
    widgets: [
      { key: "first", lines: ["one", "two"], placement: "aboveEditor" },
      { key: "second", lines: ["three", "four"], placement: "belowEditor" },
    ],
  });

  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/<section/g) ?? []).length, 1);
  assert.match(html, /aria-labelledby="[^"]*trigger-0"/);
  assert.doesNotMatch(html, /aria-labelledby="[^"]*trigger-1"/);
});

test("switching widgets closes the previously expanded widget", () => {
  assert.equal(getNextExpandedWidgetKey(null, "first"), "first");
  assert.equal(getNextExpandedWidgetKey("first", "second"), "second");
  assert.equal(getNextExpandedWidgetKey("second", "second"), null);
});

test("detects only existing widgets whose line content changed", () => {
  const previous = snapshotExtensionWidgetContents([
    { key: "changed", lines: ["one"], placement: "aboveEditor" },
    { key: "same", lines: ["ready"], placement: "belowEditor" },
    { key: "removed", lines: ["gone"], placement: "belowEditor" },
  ]);
  const next = snapshotExtensionWidgetContents([
    { key: "same", lines: ["ready"], placement: "aboveEditor" },
    { key: "changed", lines: ["one", "two"], placement: "belowEditor" },
    { key: "added", lines: ["new"], placement: "aboveEditor" },
  ]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["changed"]);
  assert.deepEqual(getUpdatedExtensionWidgetKeys(null, next), []);
});

test("compares widget lines without delimiter collisions", () => {
  const previous = new Map([["status", ["one", "two"]]]);
  const next = new Map([["status", ["one\ntwo"]]]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["status"]);
});

test("keeps one-line widgets compact but expandable", () => {
  const html = renderWidgets({
    widgets: [{ key: "single-line-widget", lines: ["ready"], placement: "belowEditor" }],
  });

  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /<svg[^>]*extension-widget-placement-icon/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
  assert.match(html, /Below editor widget/);
  assert.match(html, /<button[^>]*class="extension-widget-trigger/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="single-line-widget - Below editor widget - Expand"/);
  assert.match(html, /extension-widget-key/);
  assert.match(html, /extension-widget-update-pulse/);
  assert.doesNotMatch(html, /extension-widget-preview/);
  assert.doesNotMatch(html, /extension-widget-line-count/);
  assert.doesNotMatch(html, />ready</);
  assert.doesNotMatch(html, /<pre/);
});

test("keeps empty widgets non-interactive", () => {
  const html = renderWidgets({
    widgets: [{ key: "empty-widget", lines: [], placement: "aboveEditor" }],
  });

  assert.match(html, /<div class="extension-widget-trigger/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /aria-expanded/);
  assert.match(html, /title="empty-widget - Above editor widget"/);
});
