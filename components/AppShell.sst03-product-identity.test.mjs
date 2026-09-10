import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const localeIds = ["en", "zh-CN", "zh-TW"];
const identityMessages = {
  en: {
    enter: "Open Sausage Session Terminal",
    exit: "Close Sausage Session Terminal",
  },
  "zh-CN": {
    enter: "打开 Sausage Session Terminal",
    exit: "关闭 Sausage Session Terminal",
  },
  "zh-TW": {
    enter: "開啟 Sausage Session Terminal",
    exit: "關閉 Sausage Session Terminal",
  },
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modeButtonSource() {
  const start = source.indexOf("const renderWorkspaceModeButton");
  const end = source.indexOf("\n  const renderProjectTrustWarning", start);
  assert.ok(start >= 0, "workspace mode button renderer not found");
  assert.ok(end >= 0, "workspace mode button renderer boundary not found");
  return source.slice(start, end);
}

test("uses the formal product identity only for Wall title, toolbar, and status surfaces", () => {
  assert.match(source, /let windowTitle = "Pi Web";/);
  assert.match(source, /if \(workspaceMode === "wall"\) \{\s+windowTitle = "Sausage Session Terminal · Pi Web";/);
  assert.match(source, /else if \(activeCwdName\) \{\s+windowTitle = `\$\{activeCwdName\} - Pi Web`;/);
  assert.match(source, /aria-label=\{translate\("workspace\.wall"\)\}/);
  assert.match(source, /data-session-wall-placeholder="false"/);
  assert.doesNotMatch(source, /<div\s+data-session-wall-placeholder="true"/);
  assert.match(source, /<SessionWallToolbar[\s\S]*productIdentity="Sausage Session Terminal"/);
  assert.doesNotMatch(source, /data-global-status-bar="true"/);
});

test("localizes exact open and close labels without translating the formal name", async () => {
  const identityKeys = ["workspace.enterWall", "workspace.exitWall", "workspace.wall", "workspace.wallPlaceholder", "workspace.wallStatus"];
  for (const locale of localeIds) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    const expected = identityMessages[locale];
    for (const [key, value] of Object.entries({
      "workspace.enterWall": expected.enter,
      "workspace.exitWall": expected.exit,
      "workspace.wall": "Sausage Session Terminal",
      "workspace.wallPlaceholder": "Sausage Session Terminal",
      "workspace.wallStatus": "Sausage Session Terminal",
    })) {
      assert.match(messages, new RegExp(`"${escapeRegExp(key)}": ${escapeRegExp(JSON.stringify(value))},`));
    }
    for (const key of identityKeys) assert.match(messages, new RegExp(`"${escapeRegExp(key)}":`));
  }
});

test("keeps the Pi Web mode control accessible and uses the existing accent treatment", () => {
  const modeSource = modeButtonSource();
  assert.match(modeSource, /const label = wallActive \? translate\("workspace\.exitWall"\) : translate\("workspace\.enterWall"\);/);
  assert.match(modeSource, /title=\{label\}/);
  assert.match(modeSource, /aria-label=\{label\}/);
  assert.match(modeSource, /data-workspace-mode-control="true"/);
  assert.match(modeSource, /borderTop: wallActive \? "2px solid var\(--accent\)" : "2px solid transparent"/);
  assert.match(modeSource, /color: wallActive \? "var\(--accent\)" : "var\(--text-muted\)"/);
  assert.match(modeSource, /<svg[\s\S]*?aria-hidden="true"/);
});

test("does not add global branding assets or fixed brand colors to the mode control", () => {
  const modeSource = modeButtonSource();
  assert.doesNotMatch(modeSource, /<img\b|backgroundImage|url\(|logo|favicon/i);
  assert.doesNotMatch(modeSource, /#[0-9a-f]{3,8}/i);
});
