export type BrainStatus =
  | "DISPATCHED"
  | "WAITING_FOR_HANDS"
  | "BLOCKED_OWNER"
  | "MILESTONE_COMPLETE";

export type BrainStatusField =
  | "milestone"
  | "activeHands"
  | "blocker"
  | "newDispatches";

export type BrainStatusDiagnosticCode =
  | "missing_field"
  | "invalid_value"
  | "truncated_value"
  | "inconsistent_status";

export interface BrainStatusDiagnostic {
  code: BrainStatusDiagnosticCode;
  field?: BrainStatusField;
  message: string;
}

export interface BrainStatusSnapshot {
  status: BrainStatus;
  milestone: string | null;
  activeHands: number | null;
  blocker: string | null;
  newDispatches: number | null;
  confidence: "explicit" | "structured";
  sourceMessageTimestamp: number | null;
  diagnostics: BrainStatusDiagnostic[];
}

const MAX_LOGICAL_LINES = 120;
const MAX_TAIL_BYTES = 16 * 1024;
const MAX_BLOCKER_LENGTH = 2048;

const STATUSES = new Set<BrainStatus>([
  "DISPATCHED",
  "WAITING_FOR_HANDS",
  "BLOCKED_OWNER",
  "MILESTONE_COMPLETE",
]);

const BLOCKER_SENTINELS = new Set([
  "none",
  "null",
  "n/a",
  "na",
  "-",
  "\u7121",
  "\u6c92\u6709",
]);

const MARKER_LINE_RE = /^\s*BRAIN_STATUS\b\s*(?::|==?|[ \t]+)(.*?)\s*$/i;
const FIELD_LINE_RE = /^\s*(milestone|active_hands|blocker|new_dispatches)\b\s*(?::|==?|[ \t]+)(.*?)\s*$/i;

interface NonEmptyLine {
  text: string;
  position: number;
}

interface ExplicitMarker {
  position: number;
  status: BrainStatus | null;
}

interface FieldOccurrence {
  field: BrainStatusField;
  value: string;
  position: number;
}

function normalizeStatus(value: string): BrainStatus | null {
  const normalized = value.trim().toUpperCase();
  return STATUSES.has(normalized as BrainStatus) ? normalized as BrainStatus : null;
}

function takeLastUtf8Bytes(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= MAX_TAIL_BYTES) return value;

  let start = bytes.length - MAX_TAIL_BYTES;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

function boundedTail(text: string): string {
  const candidate = text.length > MAX_TAIL_BYTES ? text.slice(-MAX_TAIL_BYTES) : text;
  const byteTail = takeLastUtf8Bytes(candidate);
  const lines = byteTail.split(/\r\n|\n|\r/);
  return lines.length > MAX_LOGICAL_LINES
    ? lines.slice(-MAX_LOGICAL_LINES).join("\n")
    : byteTail;
}

function getNonEmptyLines(text: string): NonEmptyLine[] {
  const result: NonEmptyLine[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.trim() !== "") result.push({ text: line, position: result.length });
  }
  return result;
}

function findExplicitMarkers(lines: NonEmptyLine[]): ExplicitMarker[] {
  const markers: ExplicitMarker[] = [];
  for (const line of lines) {
    const match = MARKER_LINE_RE.exec(line.text);
    if (match) markers.push({ position: line.position, status: normalizeStatus(match[1]) });
  }
  return markers;
}

function parseFieldLine(line: string): { field: BrainStatusField; value: string } | null {
  const match = FIELD_LINE_RE.exec(line);
  if (!match) return null;

  const field = match[1].toLowerCase();
  return {
    field: field === "active_hands"
      ? "activeHands"
      : field === "new_dispatches"
        ? "newDispatches"
        : field as "milestone" | "blocker",
    value: match[2],
  };
}

function fieldRun(lines: NonEmptyLine[], center: number, direction: -1 | 1): FieldOccurrence[] {
  const centerIndex = lines.findIndex((line) => line.position === center);
  if (centerIndex < 0) return [];

  const result: FieldOccurrence[] = [];
  const seen = new Set<BrainStatusField>();
  for (let index = centerIndex + direction; index >= 0 && index < lines.length; index += direction) {
    const field = parseFieldLine(lines[index].text);
    if (!field || seen.has(field.field)) break;
    seen.add(field.field);
    result.push({ ...field, position: lines[index].position });
  }
  return result;
}

function hasEarlierStatusBoundary(
  lines: NonEmptyLine[],
  run: FieldOccurrence[],
  legacyStatus?: BrainStatus,
): boolean {
  const first = run.at(-1);
  return first !== undefined && lines.some((line) => {
    if (line.position >= first.position) return false;
    if (MARKER_LINE_RE.test(line.text)) return true;
    const status = normalizeStatus(line.text);
    return status !== null && status !== legacyStatus;
  });
}

function selectFields(
  lines: NonEmptyLine[],
  center: number,
  legacyStatus?: BrainStatus,
): Map<BrainStatusField, string> {
  const beforeRun = fieldRun(lines, center, -1);
  const afterRun = fieldRun(lines, center, 1);
  const usableBeforeRun = hasEarlierStatusBoundary(lines, beforeRun, legacyStatus) ? [] : beforeRun;
  const candidates = afterRun.length > 0 ? afterRun : usableBeforeRun;
  return new Map(candidates.map(({ field, value }) => [field, value]));
}

function diagnostic(
  code: BrainStatusDiagnosticCode,
  field: BrainStatusField,
  message: string,
): BrainStatusDiagnostic {
  return { code, field, message };
}

function parseCount(
  value: string,
  field: BrainStatusField,
  diagnostics: BrainStatusDiagnostic[],
): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    diagnostics.push(diagnostic("invalid_value", field, `${field} must be a non-negative safe integer`));
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    diagnostics.push(diagnostic("invalid_value", field, `${field} must be a non-negative safe integer`));
    return null;
  }
  return parsed;
}

function makeSnapshot(
  status: BrainStatus,
  confidence: "explicit" | "structured",
  values: Map<BrainStatusField, string>,
  sourceMessageTimestamp: number | null,
): BrainStatusSnapshot {
  const diagnostics: BrainStatusDiagnostic[] = [];

  let milestone: string | null = null;
  const milestoneValue = values.get("milestone");
  if (milestoneValue === undefined) {
    diagnostics.push(diagnostic("missing_field", "milestone", "milestone is missing"));
  } else {
    milestone = milestoneValue.trim().replace(/\s+/g, " ") || null;
    if (milestone === null) {
      diagnostics.push(diagnostic("invalid_value", "milestone", "milestone must not be empty"));
    }
  }

  let activeHands: number | null = null;
  const activeHandsValue = values.get("activeHands");
  if (activeHandsValue === undefined) {
    diagnostics.push(diagnostic("missing_field", "activeHands", "activeHands is missing"));
  } else {
    activeHands = parseCount(activeHandsValue, "activeHands", diagnostics);
  }

  let blocker: string | null = null;
  const blockerValue = values.get("blocker");
  if (blockerValue === undefined) {
    diagnostics.push(diagnostic("missing_field", "blocker", "blocker is missing"));
  } else {
    const normalized = blockerValue.trim();
    if (normalized === "") {
      diagnostics.push(diagnostic("invalid_value", "blocker", "blocker must be a value or sentinel"));
    } else if (!BLOCKER_SENTINELS.has(normalized.toLowerCase())) {
      blocker = normalized.length > MAX_BLOCKER_LENGTH
        ? Array.from(normalized).slice(0, MAX_BLOCKER_LENGTH).join("")
        : normalized;
      if (blocker.length !== normalized.length) {
        diagnostics.push(diagnostic("truncated_value", "blocker", "blocker was truncated to the parser limit"));
      }
    }
  }

  let newDispatches: number | null = null;
  const newDispatchesValue = values.get("newDispatches");
  if (newDispatchesValue === undefined) {
    diagnostics.push(diagnostic("missing_field", "newDispatches", "newDispatches is missing"));
  } else {
    newDispatches = parseCount(newDispatchesValue, "newDispatches", diagnostics);
  }

  if (status === "BLOCKED_OWNER" && blocker === null) {
    diagnostics.push(diagnostic("inconsistent_status", "blocker", "BLOCKED_OWNER has no blocker"));
  }
  if (status === "MILESTONE_COMPLETE" && activeHands !== null && activeHands > 0) {
    diagnostics.push(diagnostic("inconsistent_status", "activeHands", "MILESTONE_COMPLETE has active hands"));
  }
  if (status === "MILESTONE_COMPLETE" && newDispatches !== null && newDispatches > 0) {
    diagnostics.push(diagnostic("inconsistent_status", "newDispatches", "MILESTONE_COMPLETE has new dispatches"));
  }
  if (status === "DISPATCHED" && newDispatches === 0) {
    diagnostics.push(diagnostic("inconsistent_status", "newDispatches", "DISPATCHED has no new dispatches"));
  }

  return {
    status,
    milestone,
    activeHands,
    blocker,
    newDispatches,
    confidence,
    sourceMessageTimestamp,
    diagnostics,
  };
}

function parseStructuredStatus(
  lines: NonEmptyLine[],
  sourceMessageTimestamp: number | null,
): BrainStatusSnapshot | null {
  const terminalLines = lines.slice(-20);
  let state: BrainStatus | null = null;
  let center = -1;
  for (const line of terminalLines) {
    const parsed = normalizeStatus(line.text);
    if (parsed) {
      state = parsed;
      center = line.position;
    }
  }
  if (!state) return null;

  const values = selectFields(terminalLines, center);
  if (values.size < 2) return null;
  return makeSnapshot(state, "structured", values, sourceMessageTimestamp);
}

export function parseBrainStatus(
  text: unknown,
  sourceMessageTimestamp: number | null = null,
): BrainStatusSnapshot | null {
  if (typeof text !== "string") return null;

  const timestamp = typeof sourceMessageTimestamp === "number" && Number.isFinite(sourceMessageTimestamp)
    ? sourceMessageTimestamp
    : null;
  const lines = getNonEmptyLines(boundedTail(text));
  if (lines.length === 0) return null;

  const markers = findExplicitMarkers(lines);
  let latestMarker: ExplicitMarker | undefined;
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (marker.status && lines.length - marker.position - 1 <= 40) {
      latestMarker = marker;
      break;
    }
  }
  if (markers.length > 0) {
    if (!latestMarker?.status) return null;
    const start = Math.max(0, latestMarker.position - 12);
    const end = Math.min(lines.length, latestMarker.position + 7);
    const windowLines = lines.slice(start, end);
    return makeSnapshot(
      latestMarker.status,
      "explicit",
      selectFields(windowLines, latestMarker.position, latestMarker.status),
      timestamp,
    );
  }

  return parseStructuredStatus(lines, timestamp);
}
