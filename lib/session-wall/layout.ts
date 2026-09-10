export const SESSION_WALL_LAYOUTS = Object.freeze(["2x2", "2x4", "2x6"] as const);
export type SessionWallLayout = (typeof SESSION_WALL_LAYOUTS)[number];

export const SESSION_WALL_COLUMNS = 2;
export const SESSION_WALL_VISIBLE_ROWS = 2;
export const SESSION_WALL_GRID_GAP = 1;
export const SESSION_WALL_MIN_PANE_HEIGHT = 320;
export const SESSION_WALL_MAX_PANE_HEIGHT = 440;
export const SESSION_WALL_MOBILE_MAX_WIDTH = 640;
export const SESSION_WALL_MIN_VIEWPORT_WIDTH = 720;

type SessionWallPreset = {
  columns: 2;
  rows: 2 | 4 | 6;
  slotCount: 4 | 8 | 12;
};

const SESSION_WALL_PRESET_VALUES = {
  "2x2": Object.freeze({ columns: 2, rows: 2, slotCount: 4 }),
  "2x4": Object.freeze({ columns: 2, rows: 4, slotCount: 8 }),
  "2x6": Object.freeze({ columns: 2, rows: 6, slotCount: 12 }),
} as const satisfies Record<SessionWallLayout, SessionWallPreset>;

export const SESSION_WALL_PRESETS = Object.freeze(SESSION_WALL_PRESET_VALUES);

export type SessionWallViewportReason = "supported" | "mobile-disabled" | "too-narrow" | "invalid";

export interface SessionWallLayoutInput {
  layout: SessionWallLayout;
  viewportWidth: number;
  availableHeight: number;
}

export interface SessionWallLayoutPolicy {
  layout: SessionWallLayout;
  columns: 2;
  rows: 2 | 4 | 6;
  slotCount: 4 | 8 | 12;
  paneWidth: number;
  paneHeight: number;
  contentHeight: number;
  visibleRows: number;
  requiresOuterScroll: boolean;
  viewport: {
    supported: boolean;
    mobileDisabled: boolean;
    reason: SessionWallViewportReason;
  };
}

export function clampPaneHeight(height: number): number {
  const finiteHeight = Number.isFinite(height) ? height : SESSION_WALL_MIN_PANE_HEIGHT;
  return Math.round(Math.max(
    SESSION_WALL_MIN_PANE_HEIGHT,
    Math.min(SESSION_WALL_MAX_PANE_HEIGHT, finiteHeight),
  ));
}

function getViewportPolicy(width: number): SessionWallLayoutPolicy["viewport"] {
  if (!Number.isFinite(width) || width <= 0) {
    return { supported: false, mobileDisabled: false, reason: "invalid" };
  }
  if (width <= SESSION_WALL_MOBILE_MAX_WIDTH) {
    return { supported: false, mobileDisabled: true, reason: "mobile-disabled" };
  }
  if (width < SESSION_WALL_MIN_VIEWPORT_WIDTH) {
    return { supported: false, mobileDisabled: false, reason: "too-narrow" };
  }
  return { supported: true, mobileDisabled: false, reason: "supported" };
}

export function getSessionWallLayoutPolicy(input: SessionWallLayoutInput): SessionWallLayoutPolicy {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Session Wall layout input must be an object");
  }
  const layout = SESSION_WALL_LAYOUTS.find((candidate) => candidate === input.layout);
  if (layout === undefined) {
    throw new RangeError(`Unsupported Session Wall layout: ${String(input.layout)}`);
  }
  const preset = SESSION_WALL_PRESETS[layout];
  const viewportWidth = Number.isFinite(input.viewportWidth) ? Math.max(0, input.viewportWidth) : 0;
  const availableHeight = Number.isFinite(input.availableHeight) ? Math.max(0, input.availableHeight) : 0;
  const paneWidth = Math.max(0, Math.floor(
    (viewportWidth - SESSION_WALL_GRID_GAP) / SESSION_WALL_COLUMNS,
  ));
  const paneHeight = clampPaneHeight(Math.floor(
    Math.max(0, availableHeight - SESSION_WALL_GRID_GAP) / SESSION_WALL_VISIBLE_ROWS,
  ));
  const contentHeight = preset.rows * paneHeight + (preset.rows - 1) * SESSION_WALL_GRID_GAP;
  const visibleRows = Math.min(
    preset.rows,
    Math.max(0, Math.floor(
      (availableHeight + SESSION_WALL_GRID_GAP) / (paneHeight + SESSION_WALL_GRID_GAP),
    )),
  );

  return {
    layout,
    ...preset,
    paneWidth,
    paneHeight,
    contentHeight,
    visibleRows,
    requiresOuterScroll: preset.rows > 2 || contentHeight > availableHeight,
    viewport: getViewportPolicy(input.viewportWidth),
  };
}
