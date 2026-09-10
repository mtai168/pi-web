import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseBrainStatus } from "./brain-status.ts";

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function statusBlock(status, milestone, activeHands, blocker, newDispatches) {
  return [
    `BRAIN_STATUS: ${status}`,
    `milestone: ${milestone}`,
    `active_hands: ${activeHands}`,
    `blocker: ${blocker}`,
    `new_dispatches: ${newDispatches}`,
  ].join("\n");
}

function statusFields(result) {
  assert.ok(result);
  return {
    status: result.status,
    milestone: result.milestone,
    activeHands: result.activeHands,
    blocker: result.blocker,
    newDispatches: result.newDispatches,
    confidence: result.confidence,
    sourceMessageTimestamp: result.sourceMessageTimestamp,
  };
}

function diagnosticFields(result) {
  assert.ok(result);
  return result.diagnostics.map(({ code, field, message }) => ({ code, field, message }));
}

test("parses all canonical Brain statuses", async (t) => {
  const cases = [
    ["canonical-dispatched.txt", "DISPATCHED", "SST-01 parser dispatched", 2, null, 2],
    ["canonical-waiting.txt", "WAITING_FOR_HANDS", "I45 structured-output history remediation", 3, null, 0],
    ["canonical-blocked.txt", "BLOCKED_OWNER", "I45 owner recheck", 0, "owner physical recheck", 0],
    ["canonical-complete.txt", "MILESTONE_COMPLETE", "SST-01 parser complete", 0, null, 0],
  ];

  for (const [name, status, milestone, activeHands, blocker, newDispatches] of cases) {
    await t.test(name, async () => {
      const result = parseBrainStatus(await fixture(name), 1700000000000);
      assert.deepEqual(statusFields(result), {
        status,
        milestone,
        activeHands,
        blocker,
        newDispatches,
        confidence: "explicit",
        sourceMessageTimestamp: 1700000000000,
      });
      assert.deepEqual(result.diagnostics, []);
    });
  }
});

test("accepts legacy separators and case-insensitive keys", async () => {
  const result = parseBrainStatus(await fixture("legacy-blocked.txt"));
  assert.deepEqual(statusFields(result), {
    status: "BLOCKED_OWNER",
    milestone: "I45 structured-output history bug remediation",
    activeHands: 0,
    blocker: "owner physical recheck",
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("collects companion fields after a marker", async () => {
  const result = parseBrainStatus(await fixture("marker-before-fields.txt"));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: "marker before fields",
    activeHands: 3,
    blocker: null,
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("accepts an unmarked structured terminal block", async () => {
  const result = parseBrainStatus(await fixture("structured-terminal.txt"));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: "I45 structured output",
    activeHands: 2,
    blocker: null,
    newDispatches: 0,
    confidence: "structured",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("uses only the last explicit marker and its neighboring fields", async () => {
  const result = parseBrainStatus(await fixture("multiple-blocks.txt"));
  assert.deepEqual(statusFields(result), {
    status: "MILESTONE_COMPLETE",
    milestone: "final milestone",
    activeHands: 0,
    blocker: null,
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("does not merge fields from distinct reports across the marker window", async () => {
  const result = parseBrainStatus(await fixture("cross-block-boundary.txt"));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: null,
    activeHands: null,
    blocker: "current blocker",
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
    { code: "missing_field", field: "activeHands", message: "activeHands is missing" },
  ]);
});

test("keeps the latest marker when its block is partial", () => {
  const result = parseBrainStatus([
    "BRAIN_STATUS: WAITING_FOR_HANDS",
    "milestone: old report",
    "active_hands: 5",
    "BRAIN_STATUS: BLOCKED_OWNER",
    "blocker: current blocker",
    "new_dispatches: 0",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "BLOCKED_OWNER",
    milestone: null,
    activeHands: null,
    blocker: "current blocker",
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
    { code: "missing_field", field: "activeHands", message: "activeHands is missing" },
  ]);
});

test("does not borrow a complete legacy run when fields follow the marker", () => {
  const result = parseBrainStatus([
    "milestone: old report",
    "active_hands: 9",
    "blocker: old blocker",
    "new_dispatches: 3",
    "BRAIN_STATUS: DISPATCHED",
    "active_hands: 1",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "DISPATCHED",
    milestone: null,
    activeHands: 1,
    blocker: null,
    newDispatches: null,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
    { code: "missing_field", field: "blocker", message: "blocker is missing" },
    { code: "missing_field", field: "newDispatches", message: "newDispatches is missing" },
  ]);
});

test("keeps a partial legacy-side run when no later fields exist", () => {
  const result = parseBrainStatus([
    "milestone: partial legacy block",
    "active_hands: 2",
    "BRAIN_STATUS: DISPATCHED",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "DISPATCHED",
    milestone: "partial legacy block",
    activeHands: 2,
    blocker: null,
    newDispatches: null,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "blocker", message: "blocker is missing" },
    { code: "missing_field", field: "newDispatches", message: "newDispatches is missing" },
  ]);
});

test("does not borrow fields from a repeated earlier status block", () => {
  const result = parseBrainStatus([
    statusBlock("WAITING_FOR_HANDS", "old report", 2, "none", 0),
    "BRAIN_STATUS: DISPATCHED",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "DISPATCHED",
    milestone: null,
    activeHands: null,
    blocker: null,
    newDispatches: null,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
    { code: "missing_field", field: "activeHands", message: "activeHands is missing" },
    { code: "missing_field", field: "blocker", message: "blocker is missing" },
    { code: "missing_field", field: "newDispatches", message: "newDispatches is missing" },
  ]);
});

test("keeps an earlier valid marker when a later marker is malformed", () => {
  const result = parseBrainStatus([
    statusBlock("WAITING_FOR_HANDS", "earlier valid", 1, "none", 0),
    "BRAIN_STATUS: UNKNOWN",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: "earlier valid",
    activeHands: 1,
    blocker: null,
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("fails closed when a field boundary is ambiguous", () => {
  const result = parseBrainStatus([
    "milestone: old report",
    "BRAIN_STATUS: WAITING_FOR_HANDS",
    "active_hands: 2",
    "status prose separates reports",
    "blocker: current blocker",
    "new_dispatches: 0",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: null,
    activeHands: 2,
    blocker: null,
    newDispatches: null,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
    { code: "missing_field", field: "blocker", message: "blocker is missing" },
    { code: "missing_field", field: "newDispatches", message: "newDispatches is missing" },
  ]);
});

test("does not infer status from prose, quotes, bullets, or runtime labels", async () => {
  assert.equal(parseBrainStatus(await fixture("false-positive.txt")), null);
  assert.equal(parseBrainStatus("The runtime is RUNNING and the old state was BLOCKED_OWNER."), null);
  assert.equal(parseBrainStatus("WAITING_FOR_HANDS"), null);
  assert.equal(parseBrainStatus(null), null);
});

test("requires companion fields for an unmarked status", () => {
  assert.equal(parseBrainStatus("WAITING_FOR_HANDS\nmilestone: only one field"), null);
  assert.equal(parseBrainStatus("```\nWAITING_FOR_HANDS\n```"), null);

  const result = parseBrainStatus([
    "```",
    "WAITING_FOR_HANDS",
    "milestone: code example terminal",
    "active_hands: 1",
    "```",
  ].join("\n"));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: "code example terminal",
    activeHands: 1,
    blocker: null,
    newDispatches: null,
    confidence: "structured",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "blocker", message: "blocker is missing" },
    { code: "missing_field", field: "newDispatches", message: "newDispatches is missing" },
  ]);
});

test("accepts an explicit marker in a simple code block", () => {
  const result = parseBrainStatus([
    "```text",
    "BRAIN_STATUS: BLOCKED_OWNER",
    "milestone: code block",
    "active_hands: 0",
    "blocker: owner review",
    "new_dispatches: 0",
    "```",
  ].join("\n"));
  assert.equal(result?.status, "BLOCKED_OWNER");
  assert.equal(result?.confidence, "explicit");
  assert.equal(result?.blocker, "owner review");
  assert.deepEqual(result?.diagnostics, []);
});

test("returns null fields with diagnostics instead of guessing missing values", () => {
  const result = parseBrainStatus("BRAIN_STATUS: DISPATCHED");
  assert.deepEqual(statusFields(result), {
    status: "DISPATCHED",
    milestone: null,
    activeHands: null,
    blocker: null,
    newDispatches: null,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(result), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
    { code: "missing_field", field: "activeHands", message: "activeHands is missing" },
    { code: "missing_field", field: "blocker", message: "blocker is missing" },
    { code: "missing_field", field: "newDispatches", message: "newDispatches is missing" },
  ]);
});

test("rejects invalid count values without coercion", async (t) => {
  const cases = [
    ["-1", "1.5", "negative and decimal"],
    ["NaN", "NaN", "NaN"],
    ["999999999999999999999999999", "999999999999999999999999999", "overflow"],
    ["1.5", "1.5", "decimal counts"],
  ];

  for (const [activeHands, newDispatches, name] of cases) {
    await t.test(name, () => {
      const result = parseBrainStatus(statusBlock(
        "WAITING_FOR_HANDS",
        "I45 invalid values",
        activeHands,
        "沒有",
        newDispatches,
      ));
      assert.equal(result?.activeHands, null);
      assert.equal(result?.newDispatches, null);
      assert.deepEqual(diagnosticFields(result), [
        { code: "invalid_value", field: "activeHands", message: "activeHands must be a non-negative safe integer" },
        { code: "invalid_value", field: "newDispatches", message: "newDispatches must be a non-negative safe integer" },
      ]);
    });
  }
});

test("normalizes blocker sentinels and bounds long blocker text", () => {
  for (const sentinel of ["none", "null", "n/a", "na", "-", "無", "沒有", "NONE"]) {
    const result = parseBrainStatus(statusBlock("WAITING_FOR_HANDS", "I45 blocker", 0, sentinel, 0));
    assert.equal(result?.blocker, null, sentinel);
  }

  const longBlocker = "owner review ".repeat(300);
  const result = parseBrainStatus(statusBlock("WAITING_FOR_HANDS", "I45 blocker", 0, longBlocker, 0));
  assert.equal(result?.blocker?.length, 2048);
  assert.ok(result?.blocker?.startsWith("owner review "));
  assert.deepEqual(result?.diagnostics, [{
    code: "truncated_value",
    field: "blocker",
    message: "blocker was truncated to the parser limit",
  }]);

  const whitespace = parseBrainStatus(statusBlock("WAITING_FOR_HANDS", "I45 blocker", 0, "  owner   review  ", 0));
  assert.equal(whitespace?.blocker, "owner   review");
});

test("normalizes milestone whitespace without changing its words", () => {
  const result = parseBrainStatus([
    "BRAIN_STATUS: WAITING_FOR_HANDS",
    "milestone:   I45   structured\toutput  remediation  ",
    "active_hands: 2",
    "blocker: none",
    "new_dispatches: 0",
  ].join("\n"));
  assert.equal(result?.milestone, "I45 structured output remediation");
});

test("uses the nearest field occurrence within the bounded marker window", async () => {
  const result = parseBrainStatus(await fixture("field-window.txt"));
  assert.deepEqual(statusFields(result), {
    status: "DISPATCHED",
    milestone: "current milestone",
    activeHands: 1,
    blocker: null,
    newDispatches: 1,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);

  const tie = parseBrainStatus([
    "active_hands: 1",
    "BRAIN_STATUS: WAITING_FOR_HANDS",
    "active_hands: 2",
    "milestone: tie",
    "blocker: none",
    "new_dispatches: 0",
  ].join("\n"));
  assert.equal(tie?.activeHands, 2);

  const split = parseBrainStatus([
    "milestone: split milestone",
    "BRAIN_STATUS: WAITING_FOR_HANDS",
    "active_hands: 2",
    "blocker: none",
    "new_dispatches: 0",
  ].join("\n"));
  assert.deepEqual(statusFields(split), {
    status: "WAITING_FOR_HANDS",
    milestone: null,
    activeHands: 2,
    blocker: null,
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(diagnosticFields(split), [
    { code: "missing_field", field: "milestone", message: "milestone is missing" },
  ]);
});

test("limits parsing to the latest 120 lines and 16 KiB", async () => {
  const tail = await fixture("canonical-complete.txt");
  const lineBounded = [
    ...Array.from({ length: 130 }, (_, index) => `old line ${index}`),
    tail,
  ].join("\n");
  assert.equal(parseBrainStatus(lineBounded)?.status, "MILESTONE_COMPLETE");

  const invalidMarkerOutsideTail = [
    "BRAIN_STATUS: UNKNOWN",
    ...Array.from({ length: 120 }, (_, index) => `filler ${index}`),
    "WAITING_FOR_HANDS",
    "milestone: bounded structured status",
    "active_hands: 0",
    "blocker: none",
    "new_dispatches: 0",
  ].join("\n");
  assert.equal(parseBrainStatus(invalidMarkerOutsideTail)?.status, "WAITING_FOR_HANDS");

  const oldMarkerOutsideTail = [
    "BRAIN_STATUS: BLOCKED_OWNER",
    ...Array.from({ length: 120 }, (_, index) => `filler ${index}`),
  ].join("\n");
  assert.equal(parseBrainStatus(oldMarkerOutsideTail), null);

  const markerAtRecencyBoundary = [
    "BRAIN_STATUS: BLOCKED_OWNER",
    "milestone: recency boundary",
    "active_hands: 0",
    "blocker: owner review",
    "new_dispatches: 0",
    ...Array.from({ length: 36 }, (_, index) => `trailing line ${index}`),
  ].join("\n");
  assert.equal(parseBrainStatus(markerAtRecencyBoundary)?.status, "BLOCKED_OWNER");

  const byteBounded = `BRAIN_STATUS: BLOCKED_OWNER\n${"x".repeat(17 * 1024)}`;
  assert.equal(parseBrainStatus(byteBounded), null);
  assert.equal(parseBrainStatus(`${"x".repeat(17 * 1024)}\n${tail}`)?.status, "MILESTONE_COMPLETE");
});

test("normalizes finite source timestamps and rejects non-finite values", () => {
  const input = "BRAIN_STATUS: DISPATCHED";
  assert.equal(parseBrainStatus(input, 0)?.sourceMessageTimestamp, 0);
  assert.equal(parseBrainStatus(input, Number.MAX_SAFE_INTEGER)?.sourceMessageTimestamp, Number.MAX_SAFE_INTEGER);

  for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1700000000000", null]) {
    assert.equal(parseBrainStatus(input, timestamp)?.sourceMessageTimestamp, null, String(timestamp));
  }
});

test("reports consistency diagnostics without rewriting explicit status", () => {
  const result = parseBrainStatus([
    "BRAIN_STATUS: MILESTONE_COMPLETE",
    "milestone: done",
    "active_hands: 2",
    "blocker: none",
    "new_dispatches: 1",
  ].join("\n"));
  assert.equal(result?.status, "MILESTONE_COMPLETE");
  assert.deepEqual(diagnosticFields(result), [
    {
      code: "inconsistent_status",
      field: "activeHands",
      message: "MILESTONE_COMPLETE has active hands",
    },
    {
      code: "inconsistent_status",
      field: "newDispatches",
      message: "MILESTONE_COMPLETE has new dispatches",
    },
  ]);
});

test("accepts zero-worker waiting without an inconsistency diagnostic", () => {
  const result = parseBrainStatus(statusBlock(
    "WAITING_FOR_HANDS",
    "waiting",
    0,
    "none",
    0,
  ));
  assert.deepEqual(statusFields(result), {
    status: "WAITING_FOR_HANDS",
    milestone: "waiting",
    activeHands: 0,
    blocker: null,
    newDispatches: 0,
    confidence: "explicit",
    sourceMessageTimestamp: null,
  });
  assert.deepEqual(result.diagnostics, []);
});

test("does not expose runtime fallback statuses and rejects invalid markers", () => {
  assert.equal(parseBrainStatus("RUNNING"), null);
  assert.equal(parseBrainStatus("IDLE"), null);
  assert.equal(parseBrainStatus("BRAIN_STATUS: RUNNING"), null);
  assert.equal(parseBrainStatus("BRAIN_STATUS: UNKNOWN"), null);
  assert.equal(parseBrainStatus("BRAIN_STATUS: WAITING_FOR_HANDS\n" + Array.from({ length: 41 }, () => "explanation").join("\n")), null);
  assert.equal(parseBrainStatus("BRAIN_STATUS: WAITING_FOR_HANDS", Number.NaN)?.sourceMessageTimestamp, null);
});
