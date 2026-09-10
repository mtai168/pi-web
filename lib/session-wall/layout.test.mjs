import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SESSION_WALL_LAYOUTS,
  SESSION_WALL_MAX_PANE_HEIGHT,
  SESSION_WALL_MIN_PANE_HEIGHT,
  SESSION_WALL_PRESETS,
  clampPaneHeight,
  getSessionWallLayoutPolicy,
} = await jiti.import("./layout.ts");

const layoutInput = (layout, overrides = {}) => ({
  layout,
  viewportWidth: 1418,
  availableHeight: 845,
  ...overrides,
});

test("exposes exactly the supported presets and slot counts", () => {
  assert.deepEqual(SESSION_WALL_LAYOUTS, ["2x2", "2x4", "2x6"]);
  assert.deepEqual(Object.keys(SESSION_WALL_PRESETS), ["2x2", "2x4", "2x6"]);
  assert.deepEqual(
    Object.values(SESSION_WALL_PRESETS).map(({ slotCount }) => slotCount),
    [4, 8, 12],
  );
  assert.ok(Object.values(SESSION_WALL_PRESETS).every((preset) => Object.isFrozen(preset)));
});

test("keeps two columns and maps each preset to its row count", () => {
  for (const [layout, rows, slotCount] of [["2x2", 2, 4], ["2x4", 4, 8], ["2x6", 6, 12]]) {
    const policy = getSessionWallLayoutPolicy(layoutInput(layout));
    assert.equal(policy.columns, 2);
    assert.equal(policy.rows, rows);
    assert.equal(policy.slotCount, slotCount);
  }
});

test("calculates two readable rows from the available central height", () => {
  const policy = getSessionWallLayoutPolicy(layoutInput("2x2"));
  assert.equal(policy.paneHeight, 422);
  assert.equal(policy.contentHeight, 845);
  assert.equal(policy.visibleRows, 2);
  assert.equal(policy.requiresOuterScroll, false);
});

test("keeps pane height for larger presets and sends extra rows to the outer scroller", () => {
  const twoByTwo = getSessionWallLayoutPolicy(layoutInput("2x2"));
  const twoByFour = getSessionWallLayoutPolicy(layoutInput("2x4"));
  const twoBySix = getSessionWallLayoutPolicy(layoutInput("2x6"));

  assert.equal(twoByFour.paneHeight, twoByTwo.paneHeight);
  assert.equal(twoBySix.paneHeight, twoByTwo.paneHeight);
  assert.equal(twoByFour.contentHeight, 4 * twoByTwo.paneHeight + 3);
  assert.equal(twoBySix.contentHeight, 6 * twoByTwo.paneHeight + 5);
  assert.equal(twoByFour.requiresOuterScroll, true);
  assert.equal(twoBySix.requiresOuterScroll, true);
});

test("clamps pane heights at finite readable bounds", () => {
  assert.equal(clampPaneHeight(-1), SESSION_WALL_MIN_PANE_HEIGHT);
  assert.equal(clampPaneHeight(9999), SESSION_WALL_MAX_PANE_HEIGHT);
  assert.equal(clampPaneHeight(380.4), 380);
  assert.equal(clampPaneHeight(Number.NaN), SESSION_WALL_MIN_PANE_HEIGHT);
  assert.equal(clampPaneHeight(Number.POSITIVE_INFINITY), SESSION_WALL_MIN_PANE_HEIGHT);
});

test("returns explicit supported, mobile-disabled, and too-narrow viewport policies", () => {
  const viewportCases = [
    [1418, true, false, "supported"],
    [639, false, true, "mobile-disabled"],
    [640, false, true, "mobile-disabled"],
    [641, false, false, "too-narrow"],
    [719, false, false, "too-narrow"],
    [720, true, false, "supported"],
    [721, true, false, "supported"],
    [0, false, false, "invalid"],
    [-1, false, false, "invalid"],
    [Number.NaN, false, false, "invalid"],
  ];

  for (const [viewportWidth, supported, mobileDisabled, reason] of viewportCases) {
    assert.deepEqual(
      getSessionWallLayoutPolicy(layoutInput("2x2", { viewportWidth })).viewport,
      { supported, mobileDisabled, reason },
    );
  }
});

test("keeps clamp and visible-row boundary behavior explicit", () => {
  const belowTwoRows = getSessionWallLayoutPolicy(layoutInput("2x2", { availableHeight: 640 }));
  const atTwoRows = getSessionWallLayoutPolicy(layoutInput("2x2", { availableHeight: 641 }));
  const atMaxHeight = getSessionWallLayoutPolicy(layoutInput("2x2", { availableHeight: 881 }));
  const aboveMaxHeight = getSessionWallLayoutPolicy(layoutInput("2x2", { availableHeight: 883 }));

  assert.equal(belowTwoRows.paneHeight, SESSION_WALL_MIN_PANE_HEIGHT);
  assert.equal(belowTwoRows.visibleRows, 1);
  assert.equal(atTwoRows.paneHeight, SESSION_WALL_MIN_PANE_HEIGHT);
  assert.equal(atTwoRows.visibleRows, 2);
  assert.equal(atMaxHeight.paneHeight, SESSION_WALL_MAX_PANE_HEIGHT);
  assert.equal(aboveMaxHeight.paneHeight, SESSION_WALL_MAX_PANE_HEIGHT);
});

test("returns zero visible rows when invalid or insufficient height cannot fit a pane", () => {
  for (const availableHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const policy = getSessionWallLayoutPolicy(layoutInput("2x2", { availableHeight }));
    assert.equal(policy.paneHeight, SESSION_WALL_MIN_PANE_HEIGHT);
    assert.equal(policy.visibleRows, 0);
  }
});

test("rejects unsupported runtime layout values with a defined error", () => {
  assert.throws(
    () => getSessionWallLayoutPolicy(layoutInput("2x8")),
    { name: "RangeError", message: "Unsupported Session Wall layout: 2x8" },
  );
});

test("rejects null, undefined, and non-object runtime inputs with a defined error", () => {
  for (const input of [null, undefined, "2x2"]) {
    assert.throws(
      () => getSessionWallLayoutPolicy(input),
      TypeError,
    );
  }
});

test("rejects boxed runtime layout values with a defined error", () => {
  assert.throws(
    () => getSessionWallLayoutPolicy(layoutInput(new String("2x2"))),
    RangeError,
  );
});

test("recomputes deterministically for resized and browser-zoomed CSS viewports", () => {
  const viewports = [
    { viewportWidth: 1418, availableHeight: 845 },
    { viewportWidth: 1289, availableHeight: 768 },
    { viewportWidth: 1134, availableHeight: 675 },
  ];

  for (const viewport of viewports) {
    const input = layoutInput("2x4", viewport);
    assert.deepEqual(
      getSessionWallLayoutPolicy(input),
      getSessionWallLayoutPolicy({ ...input }),
    );
  }

  assert.equal(getSessionWallLayoutPolicy(layoutInput("2x4", viewports[1])).paneHeight, 383);
  assert.equal(getSessionWallLayoutPolicy(layoutInput("2x4", viewports[2])).paneHeight, 337);
});

test("supports the baseline 1418x945 CSS viewport without collapsing the two rows", () => {
  const policy = getSessionWallLayoutPolicy(layoutInput("2x2", {
    viewportWidth: 1418,
    availableHeight: 945,
  }));

  assert.equal(policy.viewport.supported, true);
  assert.equal(policy.columns, 2);
  assert.equal(policy.rows, 2);
  assert.equal(policy.visibleRows, 2);
  assert.equal(policy.paneHeight, SESSION_WALL_MAX_PANE_HEIGHT);
  assert.equal(policy.requiresOuterScroll, false);
});
