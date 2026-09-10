import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./BrainStatusSummary.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { BrainStatusSummary, getBrainStatusPresentation, formatBrainStatusAge } = await jiti.import("./BrainStatusSummary.tsx");
const { parseBrainStatus } = await jiti.import("../../lib/sausage-session-terminal/brain-status.ts");

const now = 1_700_000_000_000;

function answer(status, fields = {}) {
  return [
    `BRAIN_STATUS: ${status}`,
    `milestone: ${fields.milestone ?? "test milestone"}`,
    `active_hands: ${fields.activeHands ?? 1}`,
    `blocker: ${fields.blocker ?? "none"}`,
    `new_dispatches: ${fields.newDispatches ?? 0}`,
  ].join("\n");
}

function renderSummary(overrides = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(BrainStatusSummary, {
        stableFinalAnswer: answer("WAITING_FOR_HANDS", { activeHands: 3 }),
        sourceMessageTimestamp: now,
        runtimeState: "idle",
        sessionId: "session-a",
        currentSessionId: "session-a",
        now,
        ...overrides,
      }),
    ),
  );
}

test("renders all four trusted statuses with an icon, semantic code, and available hands", () => {
  for (const [status, activeHands] of [["DISPATCHED", 2], ["WAITING_FOR_HANDS", 3], ["BLOCKED_OWNER", 0], ["MILESTONE_COMPLETE", 0]]) {
    const html = renderSummary({ stableFinalAnswer: answer(status, { activeHands, newDispatches: status === "DISPATCHED" ? 2 : 0 }) });
    assert.match(html, new RegExp(`data-brain-status="${status}"`));
    assert.match(html, new RegExp(status));
    assert.match(html, new RegExp(`${activeHands} hands?`));
    assert.match(html, /<svg[^>]+aria-hidden="true"/);
  }
});

test("keeps missing and invalid fields honest and exposes parser diagnostics", () => {
  const missing = renderSummary({ stableFinalAnswer: "BRAIN_STATUS: BLOCKED_OWNER" });
  assert.match(missing, /BLOCKED_OWNER/);
  assert.match(missing, /blocker:[\s\S]*?unknown/);
  assert.match(missing, /parser diagnostics: 5/);
  assert.doesNotMatch(missing, /owner physical recheck/);

  const invalid = renderSummary({ stableFinalAnswer: answer("WAITING_FOR_HANDS", { activeHands: "many", newDispatches: "1.5" }) });
  assert.match(invalid, /activeHands must be a non-negative safe integer/);
  assert.match(invalid, /newDispatches must be a non-negative safe integer/);
  assert.match(invalid, /new dispatches:[\s\S]*?unknown/);
  assert.doesNotMatch(invalid, /- many hands/);
});

test("uses distinct runtime fallback text when no trusted snapshot exists", () => {
  const labels = ["running", "idle", "error", "unknown"].map((runtimeState) => {
    const html = renderSummary({ stableFinalAnswer: null, runtimeState });
    assert.doesNotMatch(html, /data-brain-status="/);
    assert.match(html, new RegExp(`${runtimeState.toUpperCase()} - `));
    return html;
  });
  assert.equal(new Set(labels).size, 4);
});

test("retains only the supplied stable snapshot during streaming and marks runtime running", () => {
  const previous = parseBrainStatus(answer("WAITING_FOR_HANDS", { activeHands: 2 }), now);
  const presentation = getBrainStatusPresentation({
    stableFinalAnswer: answer("MILESTONE_COMPLETE"),
    runtimeState: "running",
    streaming: true,
    previousStableSnapshot: previous,
    previousStableSnapshotSessionId: "session-a",
    sessionId: "session-a",
    currentSessionId: "session-a",
  });
  assert.equal(presentation.snapshot?.status, "WAITING_FOR_HANDS");
  assert.equal(presentation.displayRuntimeState, "running");
  const html = renderSummary({
    stableFinalAnswer: answer("MILESTONE_COMPLETE"),
    runtimeState: "running",
    streaming: true,
    previousStableSnapshot: previous,
    previousStableSnapshotSessionId: "session-a",
    now: now + 120_000,
  });
  assert.match(html, /WAITING_FOR_HANDS/);
  assert.match(html, /RUNNING/);
  assert.doesNotMatch(html, /data-brain-status="MILESTONE_COMPLETE"/);
  assert.match(html, /2m ago/);

  const noPrevious = renderSummary({ stableFinalAnswer: answer("MILESTONE_COMPLETE"), runtimeState: "running", streaming: true });
  assert.match(noPrevious, /RUNNING - No trusted Brain status/);
  assert.doesNotMatch(noPrevious, /data-brain-status="MILESTONE_COMPLETE"/);

  const foreign = getBrainStatusPresentation({
    stableFinalAnswer: null,
    runtimeState: "running",
    streaming: true,
    previousStableSnapshot: previous,
    previousStableSnapshotSessionId: "session-a",
    sessionId: "session-b",
    currentSessionId: "session-b",
  });
  assert.equal(foreign.snapshot, null);
});

test("marks stale snapshots and session identity changes as last known", () => {
  const stale = renderSummary({ snapshotStale: true });
  assert.match(stale, /STALE \/ LAST KNOWN/);
  assert.match(stale, /data-brain-stale="true"/);
  assert.match(stale, /data-brain-current="true"/);

  const replaced = renderSummary({ sessionId: "session-a", currentSessionId: "session-b" });
  assert.match(replaced, /STALE \/ LAST KNOWN/);
  assert.match(replaced, /data-brain-current="false"/);
});

test("bounds long values, provides a milestone full-value path, and renders plain text", () => {
  const milestone = "milestone " + "m".repeat(120);
  const blocker = "blocker " + "b".repeat(180);
  const html = renderSummary({ stableFinalAnswer: answer("BLOCKED_OWNER", { milestone, blocker, activeHands: 0 }) });
  assert.match(html, new RegExp(`title="${milestone}"`));
  assert.match(html, /text-overflow:ellipsis/);
  assert.match(html, /white-space:nowrap/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /max-height:3\.2em/);
  assert.match(html, new RegExp(`title="${blocker}"`));

  const oversized = renderSummary({ stableFinalAnswer: answer("WAITING_FOR_HANDS", { milestone: "m".repeat(3_000) }) });
  assert.match(oversized, /data-brain-milestone-truncated="true"/);
  assert.doesNotMatch(oversized, new RegExp(`title="${"m".repeat(3_000)}"`));

  const unsafe = "<script>alert(1)</script>";
  const safeHtml = renderSummary({ stableFinalAnswer: answer("WAITING_FOR_HANDS", { milestone: unsafe, blocker: unsafe }) });
  assert.doesNotMatch(safeHtml, /<script>alert/);
  assert.match(safeHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("keeps independent session calls independent and limits this hand to presentation", () => {
  const first = getBrainStatusPresentation({
    stableFinalAnswer: answer("DISPATCHED"),
    runtimeState: "idle",
    sessionId: "session-a",
    currentSessionId: "session-a",
  });
  const second = getBrainStatusPresentation({
    stableFinalAnswer: null,
    runtimeState: "idle",
    sessionId: "session-b",
    currentSessionId: "session-b",
  });
  assert.equal(first.snapshot?.status, "DISPATCHED");
  assert.equal(second.snapshot, null);
  assert.doesNotMatch(renderSummary({ sessionId: "session-b", currentSessionId: "session-b", stableFinalAnswer: null }), /test milestone/);
  assert.doesNotMatch(source, /useState|useRef|Map\(|fetch\(|EventSource|setInterval|setTimeout|SessionWallPane|SessionWall|ChatWindow|useAgentSession/);
  assert.equal(formatBrainStatusAge(now, now + 120_000), "2m ago");
  assert.match(source, /Epoch milliseconds, matching the parser's sourceMessageTimestamp/);
});

// SSR/source checks cover truthful presentation only; caller wiring and client lifecycle are SST-04/integration work.
test("documents the intentional caller boundary", () => {
  assert.match(source, /getBrainStatusPresentation/);
  assert.match(source, /currentSessionId/);
  assert.match(source, /previousStableSnapshot/);
  assert.match(source, /render a projection|No trusted Brain status|data-brain-status-summary/);
});

test("renders as a compact top-right overlay bounded to 1/6 viewport and half a pane", () => {
  const html = renderSummary();
  // Overlay placement inside the pane: in-flow, right-aligned, anchored at
  // top:8/right:8 by margins so the hosting stack sizes to its real height.
  assert.match(html, /<details[^>]*data-brain-status-summary="true"/);
  assert.match(html, /align-self:flex-end/);
  assert.match(html, /margin-top:8px;margin-right:8px/);
  assert.doesNotMatch(html, /bottom:8px/);
  assert.doesNotMatch(html, /position:absolute/);
  // Width: at most 1/6 of the viewport (owner cap), capped for very wide
  // desktops, and never more than half the pane width.
  assert.match(html, /width:min\(calc\(100vw \/ 6\), 280px\)/);
  assert.match(html, /max-width:50%/);
  // The disclosure is a native details/summary: keyboard accessible without
  // component state, and the status semantics stay on a live region inside.
  assert.match(html, /<summary[^>]*>/);
  assert.match(html, /<span[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /aria-label="Brain status WAITING_FOR_HANDS/);
  // The details is a shrinkable flex item of the brain row (flex 0 1 auto,
  // min-height 0) and scrolls its own content when the measured stack cap
  // binds; the sticky summary keeps the pill visible while the body scrolls.
  assert.match(html, /min-height:0/);
  assert.match(html, /flex:0 1 auto/);
  assert.match(html, /overflow-y:auto/);
  assert.match(html, /overscroll-behavior:contain/);
  assert.match(html, /<summary[^>]*style="[^"]*position:sticky;top:0;flex-shrink:0;z-index:1"/);
  // Status text, hands, and diagnostics are preserved in the compact form.
  assert.match(html, /WAITING_FOR_HANDS/);
  assert.match(html, /- 3 hands/);
  assert.match(html, /milestone:/);
  // Narrow panes: the pill clips and truncates its indicators instead of
  // painting outside the box.
  assert.match(html, /overflow:hidden/);
  assert.match(html, /flex-shrink:1/);
  const diagnosticHtml = renderSummary({ stableFinalAnswer: "BRAIN_STATUS: BLOCKED_OWNER" });
  assert.match(diagnosticHtml, /data-brain-diagnostics=/);
  assert.match(diagnosticHtml, /parser diagnostics: 5/);
  assert.doesNotMatch(source, /useState|useRef|Map\(|fetch\(|EventSource|setInterval|setTimeout/);
});

test("accessible status text includes age and non-streaming runtime state", () => {
  const html = renderSummary({ sourceMessageTimestamp: now, now: now + 120_000, runtimeState: "idle" });
  assert.match(html, /aria-label="Brain status WAITING_FOR_HANDS: Waiting for hands, 3 hands, 2m ago, runtime: idle"/);
  const previous = parseBrainStatus(answer("WAITING_FOR_HANDS", { activeHands: 2 }), now);
  const streamingHtml = renderSummary({ runtimeState: "running", streaming: true, previousStableSnapshot: previous, previousStableSnapshotSessionId: "session-a" });
  assert.match(streamingHtml, /aria-label="[^"]*runtime running"/);
  const errorHtml = renderSummary({ runtimeState: "error" });
  assert.match(errorHtml, /aria-label="[^"]*runtime: error"/);
  const noAge = renderSummary({ sourceMessageTimestamp: null });
  assert.doesNotMatch(noAge, /aria-label="[^"]*just now/);
});

test("expanded details open downward from the top anchor and shrink inside the measured cap", () => {
  const html = renderSummary();
  // The disclosure grows downward from the top anchor (plain column), so the
  // open popover can never cover the wall composer at the pane bottom.
  assert.match(html, /flex-direction:column/);
  assert.doesNotMatch(html, /column-reverse/);
  assert.match(html, /border-radius:0 0 8px 8px/);
  assert.match(html, /border-top:none/);
  assert.doesNotMatch(html, /border-bottom:none/);
  // The stack cap is the measured pane-top→composer-top room (ChatWindow
  // owns the measurement); the details row shrinks inside it via flex
  // (flex: 0 1 auto, min-height: 0) and the details scrolls its own content,
  // so the notice row keeps its 60px toast floor instead of being pushed out.
  assert.match(source, /flex: "0 1 auto", overflowY: "auto", overscrollBehavior: "contain"/);
  assert.match(source, /position: "sticky", top: 0, flexShrink: 0, zIndex: 1/);
  assert.doesNotMatch(source, /maxHeight: "100%"/);
  assert.doesNotMatch(source, /maxHeight: "calc\(100% - 8px\)"/);
  assert.match(source, /marginTop: 8, marginRight: 8/);
  assert.doesNotMatch(source, /bottom: 8/);
});

test("keeps the overlay from blocking the transcript when closed", () => {
  const html = renderSummary();
  // The pill is the only interactive element; the popover content is inside
  // the native disclosure and the wrapper never covers the full pane.
  assert.match(html, /<summary/);
  assert.doesNotMatch(html, /aria-modal/);
  assert.match(source, /alignSelf: "flex-end", marginTop: 8, marginRight: 8, zIndex: 50/);
  assert.doesNotMatch(source, /bottom: 8/);
  assert.match(source, /maxWidth: "50%"/);
});

test("fallback states render a plain pill instead of an empty disclosure", () => {
  const html = renderSummary({ stableFinalAnswer: null, runtimeState: "idle" });
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
  assert.match(html, /data-brain-runtime-fallback="idle"/);
  assert.match(html, /IDLE - No trusted Brain status/);
  assert.match(html, /data-brain-status-summary="true"/);
});
