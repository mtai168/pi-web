import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0, `missing section start: ${startText}`);
  assert.ok(end > start, `missing section end: ${endText}`);
  return source.slice(start, end);
}

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  const autoNameEligibility = section("const hasMessages = Boolean(", "const disabled =");
  assert.match(
    autoNameEligibility,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| \(toolbarSession\.messageCount \?\? 0\) > 0/,
  );
  assert.match(source, /const toolbarSession = workspaceMode === "wall" \? focusedWallSession : selectedSession/);
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  const autoNameEligibility = section("const hasMessages = Boolean(", "const isSuccess =");
  assert.match(
    autoNameEligibility,
    /const disabled = !toolbarSession \|\| toolbarSession\.transient \|\| !hasMessages/,
  );
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  const hydrateSource = section("const hydrateSelectedSession", "const handleSessionCreated");
  const completionSource = section("const handleAgentEndForSession", "const handleAgentEnd = useCallback");
  const normalCompletionSource = section("const handleAgentEnd = useCallback", "const handleAttentionNeededForSession");

  assert.match(hydrateSource, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(completionSource, /if \(targetSession\) hydrateSelectedSession\(targetSession\.id\)/);
  assert.match(normalCompletionSource, /handleAgentEndForSession\(selectedSession\)/);
});
