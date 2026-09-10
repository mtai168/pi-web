export const SESSION_WALL_STORAGE_KEY = "pi-web:session-walls:v1";
export const SESSION_WALL_SCHEMA_VERSION = 1 as const;
export const SESSION_WALL_LAYOUTS = ["2x2", "2x4", "2x6"] as const;

export type SessionWallLayout = (typeof SESSION_WALL_LAYOUTS)[number];

export const SESSION_WALL_SLOT_COUNTS = Object.freeze({
  "2x2": 4,
  "2x4": 8,
  "2x6": 12,
} as const);

export interface SessionWallPaneConfig {
  paneId: string;
  sessionId: string | null;
  runtimeRevision?: number;
}

export interface SessionWallConfigV1 {
  version: typeof SESSION_WALL_SCHEMA_VERSION;
  wallId: string;
  name: string;
  layout: SessionWallLayout;
  panes: SessionWallPaneConfig[];
  focusedPaneId: string | null;
  outerScrollTop: number;
  updatedAt: string;
}

export interface SessionWallsStoreV1 {
  version: typeof SESSION_WALL_SCHEMA_VERSION;
  activeWallId: string;
  walls: SessionWallConfigV1[];
}

export type SessionWallConfig = SessionWallConfigV1;
export type SessionWallsStore = SessionWallsStoreV1;
