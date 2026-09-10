import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutSource = await readFile(new URL("./layout.tsx", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("./globals.css", import.meta.url), "utf8");

test("keeps fonts local and preserves the mono fallback contract", () => {
  const source = `${layoutSource}\n${stylesSource}`;

  assert.doesNotMatch(source, /next\/font\/google|Noto_Sans_Mono|font-noto-mono/);
  assert.doesNotMatch(source, /https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)/i);
  assert.match(
    stylesSource,
    /--font-mono:\s*'JetBrains Mono',\s*'Fira Code',\s*'Consolas',\s*ui-monospace,\s*'PingFang SC',\s*'Microsoft YaHei',\s*monospace\s*;/,
  );
  assert.match(stylesSource, /--font-mono-font:\s*var\(--font-mono\)/);
});
