import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SessionWallToolbar } = await jiti.import("./SessionWallToolbar.tsx");
const source = await readFile(new URL("./SessionWallToolbar.tsx", import.meta.url), "utf8");
const PRODUCT_IDENTITY = "Sausage Session Terminal";

function renderToolbar(productIdentity) {
  return renderToStaticMarkup(React.createElement(SessionWallToolbar, {
    layout: "2x4",
    runningCount: 7,
    attentionCount: 2,
    productIdentity,
    labels: { layout: "Disposition", manage: "Manage sessions", running: "Active", attention: "Attention" },
    ariaLabel: "Wall controls",
    onLayoutChange() {},
    onOpenManagement() {},
  }));
}

test("renders the injected formal identity separately from functional toolbar labels", () => {
  const html = renderToolbar(PRODUCT_IDENTITY);
  assert.equal(html.match(new RegExp(PRODUCT_IDENTITY, "g"))?.length, 1);
  assert.match(html, /data-session-wall-product-identity="true"[^>]*>Sausage Session Terminal<\/span>/);
  assert.match(html, /role="toolbar" aria-label="Wall controls"/);
  assert.match(html, /Disposition/);
  assert.match(html, /Active: 7/);
  assert.match(html, /Attention: 2/);
  assert.match(html, /Manage sessions/);
  assert.match(html, /2x2/);
  assert.match(html, /2x4/);
  assert.match(html, /2x6/);
});

test("collapses low-priority toolbar content without losing accessible layout management", () => {
  const html = renderToolbar(PRODUCT_IDENTITY).replace(/Attention: 2/g, "");
  assert.match(html, /wall-toolbar-layout-select/);
  assert.match(html, /@media \(max-width:760px\)/);
  const zero = renderToStaticMarkup(React.createElement(SessionWallToolbar, {
    layout: "2x2",
    runningCount: 0,
    attentionCount: 0,
    onLayoutChange() {},
    onOpenManagement() {},
  }));
  assert.doesNotMatch(zero, /Needs attention/);
  assert.match(zero, /aria-label="Running: 0"/);
});
test("omits product identity from the generic toolbar when no identity is injected", () => {
  const html = renderToolbar(undefined);
  assert.doesNotMatch(html, /data-session-wall-product-identity|Sausage Session Terminal/);
  assert.match(html, /role="toolbar" aria-label="Wall controls"/);
  assert.match(html, /Disposition/);
  assert.match(html, /Active: 7/);
  assert.match(html, /Attention: 2/);
  assert.match(html, /Manage sessions/);
});

test("keeps product identity visible when no compact identity is supplied", () => {
  const html = renderToStaticMarkup(React.createElement(SessionWallToolbar, {
    layout: "2x2",
    runningCount: 0,
    attentionCount: 0,
    productIdentity: PRODUCT_IDENTITY,
    onLayoutChange() {},
    onOpenManagement() {},
  }));
  assert.match(html, /wall-toolbar-product-fallback[^>]*data-session-wall-product-identity="true"/);
  assert.match(source, /wall-toolbar-product-fallback/);
});

test("keeps the identity on existing Pi Web tokens without branding assets or fixed colors", () => {
  assert.match(source, /productIdentity\?: string;/);
  assert.match(source, /data-session-wall-product-identity="true"/);
  assert.doesNotMatch(source, /<img\b|backgroundImage|url\(|logo|favicon/i);
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}/i);
});
