import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("renders temporary notices once at the top right of the chat column", () => {
  const noticeShelfUsages = source.match(/<NoticeShelf notices=\{notices\}/g) ?? [];

  assert.equal(noticeShelfUsages.length, 2);
  // Both branches share one base style; only top/right placement differs.
  assert.match(source, /const NOTICE_LAYER_BASE_STYLE: CSSProperties = \{[\s\S]*?position: "absolute",[\s\S]*?justifyContent: "flex-end",[\s\S]*?pointerEvents: "none",[\s\S]*?\};/);
  assert.match(
    source,
    /\.\.\.NOTICE_LAYER_BASE_STYLE,\s*top: 12,\s*right: isMobile \? 0 : CHAT_MINIMAP_WIDTH,[\s\S]*?<NoticeShelf notices=\{notices\} floating onPauseChange=\{setNoticePaused\} \/>/,
  );
});

test("wall panes keep the notice shelf in-flow below the Brain overlay in a two-row stack", async () => {
  const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // The Brain summary and the notice shelf share one top-right stack: the
  // shelf is the in-flow second row (8px gap), never absolutely offset below
  // the rendered overlay height.
  assert.match(source, /className="chat-brain-stack"/);
  assert.match(
    source,
    /position: "absolute",\s*top: 0,\s*left: 0,\s*right: 0,\s*zIndex: 40,[\s\S]*?flexDirection: "column",\s*gap: 8,[\s\S]*?height: "100%",\s*maxHeight: "100%",[\s\S]*?overflow: "hidden",[\s\S]*?flex: "0 1 auto",\s*minHeight: 0,[\s\S]*?\{brainStatusSummary\}[\s\S]*?\.\.\.NOTICE_LAYER_BASE_STYLE,[\s\S]*?position: "relative",\s*right: 0,[\s\S]*?minHeight: notices\.length > 0 \? "min\(60px, 100%\)" : 0,[\s\S]*?maxHeight: "100%",[\s\S]*?overflowY: "auto",[\s\S]*?<NoticeShelf notices=\{notices\} floating onPauseChange=\{setNoticePaused\} \/>/,
  );
  // The stack is the first child of the composer-excluding content container
  // (relative flex min-h-0 flex-1 overflow-hidden), whose bottom edge ends
  // above the composer; height 100% of that container is the authoritative
  // boundary, so the stack can never cover the composer. The structural pin
  // proves the stack is inside the container, not a later sibling.
  assert.match(source, /className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">\s*\{isWallPane && \(\s*<div\s+className="chat-brain-stack"/);
  assert.doesNotMatch(source, /maxHeight: "calc\(100% - 8px\)"/);
  // No absolute wall notice offset remains: toasts are in-flow, and the
  // 44px pill clearance / 288px open-popover offsets are gone (the transcript
  // keeps its own message clearance below the top-anchored pill).
  assert.doesNotMatch(source, /top: "calc\(100% \+ 8px\)"/);
  assert.doesNotMatch(source, /paddingTop: isWallPane \? 44 : undefined,\s*pointerEvents/);
  assert.doesNotMatch(cssSource, /288px/);
  assert.doesNotMatch(cssSource, /padding-top: 288px/);
});

test("wall overlay keeps no measured-height state, observers, or listeners", () => {
  // The stack is bounded by the composer-excluding content container, so no
  // pane/composer measurement, ResizeObserver, or viewport listener exists.
  assert.doesNotMatch(source, /wallOverlayHeight/);
  assert.doesNotMatch(source, /wallOverlayObserverRef/);
  assert.doesNotMatch(source, /measureWallOverlay/);
  assert.doesNotMatch(source, /attachWallPaneRef/);
  assert.doesNotMatch(source, /attachWallComposerRef/);
  assert.doesNotMatch(source, /wallPaneRef/);
  assert.doesNotMatch(source, /wallComposerRef/);
  assert.doesNotMatch(source, /visualViewport\?\s*\.\s*addEventListener\("resize", measureWallOverlay\)/);
  assert.doesNotMatch(source, /addEventListener\("resize", measureWallOverlay\)/);
  assert.doesNotMatch(source, /removeEventListener\("resize", measureWallOverlay\)/);
  assert.doesNotMatch(source, /new ResizeObserver\(measureWallOverlay\)/);
  assert.doesNotMatch(source, /observer\.observe\(pane\)/);
  assert.doesNotMatch(source, /observer\.observe\(composer\)/);
  assert.doesNotMatch(source, /ref=\{attachWallPaneRef\}/);
  assert.doesNotMatch(source, /ref=\{attachWallComposerRef\}/);
  // The stack's height is a container-bound literal: reintroducing any
  // measured height would have to replace it with a variable, breaking this
  // pin. Behavioral absence (containment under position-only shifts and
  // wall/non-wall replacement) is covered by the real-browser fixture.
  assert.match(source, /className="chat-brain-stack"[\s\S]*?height: "100%",\s*maxHeight: "100%"/);
  // The stack is the first child of the composer-excluding content container,
  // so its height is bounded by the container (which ends above the
  // composer) and needs no measurement.
  assert.match(source, /className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">\s*\{isWallPane && \(\s*<div\s+className="chat-brain-stack"/);
});

test("long notices shrink inside the container-bound stack and scroll through the text span", () => {
  // The notice row is a real scroll viewport: 60px floor only when notices
  // exist, capped to the container height (min(60px, 100%)) so a very short
  // container can never clip the row, bounded maxHeight, overflowY auto.
  assert.match(source, /minHeight: notices\.length > 0 \? "min\(60px, 100%\)" : 0,/);
  assert.match(source, /maxHeight: "100%",\s*overflowY: "auto",/);
  // The shelf and each toast can shrink (minHeight 0 / flex 0 1 auto) so the
  // row's bounded height actually constrains them instead of clipping.
  assert.match(source, /minHeight: 0,\s*maxHeight: "100%",/);
  assert.match(source, /flex: "0 1 auto",[\s\S]*?maxHeight: NOTICE_MAX_HEIGHT_PX,/);
  // The long text's span stretches to the constrained toast height and
  // scrolls internally (keyboard-focusable, wheel-scrollable).
  assert.match(source, /<span\s+tabIndex=\{0\}\s+style=\{\{[^}]*overflowY: "auto",[^}]*alignSelf: "stretch",[^}]*minHeight: 0 \}\}/);
});

test("pauses only for a visible notice", () => {
  assert.match(
    hookSource,
    /noticeState\.visible\.some\(\(notice\) => notice\.id === pausedNoticeId\)\) return/,
  );
});

test("lets keyboard users pause and scroll long notices", () => {
  assert.match(source, /onFocus=\{\(\) => onPauseChange\?\.\(notice\.id\)\}/);
  assert.match(source, /onBlur=\{\(event\) => \{\s*if \(!event\.currentTarget\.matches\(":hover"\)\) onPauseChange\?\.\(null\)/);
  assert.match(source, /onMouseLeave=\{\(event\) => \{\s*if \(!event\.currentTarget\.contains\(document\.activeElement\)\) onPauseChange\?\.\(null\)/);
  assert.match(source, /<span\s+tabIndex=\{0\}\s+style=\{\{[^}]*overflowY: "auto"/);
});

test("copies notice text with accessible feedback while preserving selection and pause", () => {
  // The copy action uses the shared clipboard helper on the full notice text.
  assert.match(source, /import \{ copyText \} from "@\/lib\/clipboard";/);
  assert.match(source, /copyText\(notice\.message\)\.then\(\(\) => \{/);
  // Superseded copy requests are ignored and clipboard denial is contained.
  assert.match(source, /const requestId = \+\+copyRequestIdRef\.current;/);
  assert.match(source, /if \(copyRequestIdRef\.current !== requestId\) return;/);
  assert.match(source, /\)\.catch\(\(\) => \{/);
  // Clipboard denial shows visible failure feedback with the same timer.
  assert.match(source, /setCopyFailedId\(notice\.id\);/);
  // Accessible label/title and visible copied feedback, derived from one
  // three-state value so the visual and accessible states cannot diverge.
  assert.match(source, /const copyState = getCopyFeedbackState\(copiedId, copyFailedId, notice\.id\);/);
  assert.match(source, /const copyLabel = getCopyFeedbackLabel\(copyState, t\);/);
  assert.match(source, /function getCopyFeedbackState\(copiedId: string \| null, copyFailedId: string \| null, noticeId: string\)/);
  assert.match(source, /if \(copiedId === noticeId\) return "copied";/);
  assert.match(source, /if \(copyFailedId === noticeId\) return "failed";/);
  assert.match(source, /function getCopyFeedbackLabel\(state: CopyFeedbackState, t: \(key: string\) => string\)/);
  assert.match(source, /if \(state === "copied"\) return t\("i18n\.copied"\);/);
  assert.match(source, /if \(state === "failed"\) return t\("i18n\.copyFailed"\);/);
  assert.match(source, /getCopyFeedbackColor\(copyState\)/);
  assert.match(source, /title=\{copyLabel\}/);
  assert.match(source, /aria-label=\{copyLabel\}/);
  assert.match(source, /setCopiedId\(notice\.id\);/);
  assert.match(source, /setTimeout\(\(\) => setCopiedId\(null\), 1400\);/);
  // Unmount invalidates pending clipboard requests so late settlements cannot
  // update state or schedule timers.
  assert.match(source, /copyRequestIdRef\.current \+= 1;/);
  // The selectable text span is untouched and the button lives inside the
  // toast, so hover/focus pause and expiry behavior still apply to it.
  assert.match(source, /<span\s+tabIndex=\{0\}\s+style=\{\{ padding: "14px 0"/);
  assert.match(source, /onClick=\{\(\) => copyNotice\(notice\)\}/);
  assert.match(source, /onMouseEnter=\{\(\) => onPauseChange\?\.\(notice\.id\)\}/);
  assert.match(source, /const copyNotice = \(notice: NoticeItem\) => \{/);
});
