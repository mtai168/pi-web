import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith("ChatMinimap.module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default {};",
    };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  countCurrentWallAttentionReports,
  shouldRenderWallBrainStatusSummary,
  getAssistantFinalAnswerText,
  getLatestAssistantFinalAnswer,
  isCurrentBrainStatusReport,
} = await jiti.import("./ChatWindow.tsx");
const { getBrainStatusPresentation } = await jiti.import("./sausage-session-terminal/BrainStatusSummary.tsx");
const { parseBrainStatus } = await jiti.import("../lib/sausage-session-terminal/brain-status.ts");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });
const toolCall = { type: "toolCall", toolCallId: "tool", toolName: "read", input: {} };
const assistant = (content, timestamp = 1) => ({
  role: "assistant",
  content,
  model: "test",
  provider: "test",
  timestamp,
});
const answer = (status) => [
  `BRAIN_STATUS: ${status}`,
  "milestone: test milestone",
  "active_hands: 1",
  "blocker: none",
  "new_dispatches: 0",
].join("\n");
const identity = (paneId, sessionId, runtimeRevision = 0, wallId = "wall-a") => ({
  paneId,
  sessionId,
  runtimeKey: JSON.stringify([paneId, sessionId, runtimeRevision]),
  wallId,
});

test("selects only the latest non-empty Assistant final-answer text", () => {
  const processOnly = assistant([text("draft"), toolCall]);
  const latest = assistant([thinking("private process"), text("process draft"), toolCall, text(answer("WAITING_FOR_HANDS"))], 42);
  const messages = [
    assistant([text(answer("DISPATCHED"))], 10),
    { role: "user", content: "ignore this" },
    { role: "toolResult", toolCallId: "tool", content: [text(answer("BLOCKED_OWNER"))] },
    processOnly,
    latest,
  ];

  assert.equal(getAssistantFinalAnswerText(processOnly), null);
  assert.equal(getAssistantFinalAnswerText(latest), answer("WAITING_FOR_HANDS"));
  assert.deepEqual(getLatestAssistantFinalAnswer(messages), {
    text: answer("WAITING_FOR_HANDS"),
    sourceMessageTimestamp: 42,
  });
});

test("bounds the plain-text source and fails closed instead of falling back to an older answer", () => {
  const bounded = getAssistantFinalAnswerText(assistant([text("x".repeat(20_000))]));
  assert.equal(bounded.length, 16 * 1024);

  const oldAnswer = assistant([text(answer("DISPATCHED"))], 1);
  const newestAnswer = assistant([text("The newest answer has no trusted status block.")], 2);
  const selected = getLatestAssistantFinalAnswer([oldAnswer, newestAnswer]);
  assert.equal(selected?.text, "The newest answer has no trusted status block.");
  assert.equal(parseBrainStatus(selected?.text ?? null), null);
});

test("retains a session-local snapshot only while streaming and replaces it when settled", () => {
  const previous = parseBrainStatus(answer("WAITING_FOR_HANDS"), 1);
  const next = getLatestAssistantFinalAnswer([assistant([text(answer("MILESTONE_COMPLETE"))], 2)]);
  assert.ok(previous);
  assert.ok(next);

  const streaming = getBrainStatusPresentation({
    stableFinalAnswer: next.text,
    runtimeState: "running",
    streaming: true,
    previousStableSnapshot: previous,
    previousStableSnapshotSessionId: "session-a",
    sessionId: "session-a",
    currentSessionId: "session-a",
  });
  assert.equal(streaming.snapshot?.status, "WAITING_FOR_HANDS");
  assert.equal(streaming.displayRuntimeState, "running");

  const settled = getBrainStatusPresentation({
    stableFinalAnswer: next.text,
    sourceMessageTimestamp: next.sourceMessageTimestamp,
    runtimeState: "idle",
    previousStableSnapshot: previous,
    previousStableSnapshotSessionId: "session-a",
    sessionId: "session-a",
    currentSessionId: "session-a",
  });
  assert.equal(settled.snapshot?.status, "MILESTONE_COMPLETE");

  const noSnapshot = getBrainStatusPresentation({
    stableFinalAnswer: next.text,
    runtimeState: "running",
    streaming: true,
    sessionId: "session-a",
    currentSessionId: "session-a",
  });
  assert.equal(noSnapshot.snapshot, null);
  assert.equal(noSnapshot.displayRuntimeState, "running");

  const replacement = getBrainStatusPresentation({
    stableFinalAnswer: next.text,
    runtimeState: "running",
    streaming: true,
    previousStableSnapshot: previous,
    previousStableSnapshotSessionId: "session-a",
    sessionId: "session-a",
    currentSessionId: "session-b",
  });
  assert.equal(replacement.snapshot, null);
});

test("suppresses only the untrusted idle fallback while keeping actionable/runtime states visible", () => {
  assert.equal(shouldRenderWallBrainStatusSummary("idle", false), false);
  assert.equal(shouldRenderWallBrainStatusSummary("idle", true), true);
  assert.equal(shouldRenderWallBrainStatusSummary("running", false), true);
  assert.equal(shouldRenderWallBrainStatusSummary("error", false), true);
  assert.equal(shouldRenderWallBrainStatusSummary("unknown", false), true);
  assert.equal(parseBrainStatus(answer("WAITING_FOR_HANDS"))?.status, "WAITING_FOR_HANDS");
  assert.equal(parseBrainStatus(answer("BLOCKED_OWNER"))?.status, "BLOCKED_OWNER");
});
test("filters attention reports by pane, session, runtime, wall, status, and staleness", () => {
  const paneA = identity("pane-a", "session-a");
  const paneB = identity("pane-b", "session-b");
  const blockedA = { ...paneA, status: "BLOCKED_OWNER", stale: false };
  const blockedBStale = { ...paneB, status: "BLOCKED_OWNER", stale: true };
  assert.equal(isCurrentBrainStatusReport(blockedA, paneA), true);
  assert.equal(isCurrentBrainStatusReport(blockedA, { ...paneA, sessionId: "session-other" }), false);
  assert.equal(isCurrentBrainStatusReport(blockedA, { ...paneA, runtimeKey: JSON.stringify(["pane-a", "session-a", 1]) }), false);
  assert.equal(isCurrentBrainStatusReport(blockedA, { ...paneA, wallId: "wall-b" }), false);
  assert.equal(countCurrentWallAttentionReports([paneA, paneB], {
    "pane-a": blockedA,
    "pane-b": blockedBStale,
  }), 1);
  assert.equal(countCurrentWallAttentionReports([paneA, paneB], {
    "pane-a": { ...blockedA, status: "WAITING_FOR_HANDS" },
    "pane-b": { ...blockedBStale, stale: false, wallId: "wall-b" },
  }), 0);
});

test("wires Wall status reporting and toolbar identity without changing normal branding", () => {
  assert.match(chatWindowSource, /brainStatusIdentity\?: BrainStatusPaneIdentity/);
  assert.match(chatWindowSource, /onBrainStatusReport\?: \(report: BrainStatusReport\) => void/);
  assert.match(chatWindowSource, /const brainStatusSummary = isWallPane && session\?\.id && showBrainStatusSummary/);
  assert.match(chatWindowSource, /if \(!isWallPane \|\| loading \|\| sessionBusy \|\| streamState\.isStreaming/);
  assert.match(chatWindowSource, /previousStableSnapshotSessionId=\{session\.id\}/);
  assert.match(chatWindowSource, /return \(\) => onBrainStatusReport\(\{ \.\.\.identity, status: null, stale: true \}\)/);
  assert.match(appShellSource, /<SessionWallToolbar[\s\S]*productIdentity="Sausage Session Terminal"/);
  assert.match(appShellSource, /attentionCount=\{wallAttentionCount\}/);
  assert.match(appShellSource, /onBrainStatusReport=\{handleWallBrainStatusReport\}/);
  assert.match(appShellSource, /brainStatusIdentity=\{\{/);
  assert.match(appShellSource, /key=\{context\.runtime\.runtimeKey\}/);
  assert.match(appShellSource, /data-session-wall-placeholder="false"/);
  assert.match(appShellSource, /let windowTitle = "Pi Web";/);
  assert.match(appShellSource, /windowTitle = "Sausage Session Terminal · Pi Web";/);
});

test("keeps the Wall labels in all supported locale packages", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const source = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of [
      "brainStatus.summary",
      "brainStatus.description.dispatched",
      "brainStatus.description.waiting",
      "brainStatus.description.blocked",
      "brainStatus.description.complete",
      "brainStatus.fallback.running",
      "brainStatus.fallback.idle",
      "brainStatus.fallback.error",
      "brainStatus.fallback.unknown",
      "brainStatus.milestone",
      "brainStatus.blocker",
      "brainStatus.newDispatches",
    ]) assert.match(source, new RegExp(`"${key}":`));
  }
});
