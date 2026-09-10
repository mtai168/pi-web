import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.content, "Parser found");
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

test("subagent JSONL appends are fenced against revocation", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(
    source.indexOf("const authority = await getSessionAuthorityManager().acquireSessionAppender"),
    source.indexOf("const initialRun: SubagentRunInfo"),
  );
  const completionSource = source.slice(
    source.indexOf("const persisted: SubagentResultMetadata"),
    source.indexOf("stored.run = result"),
  );

  // The appender is bound to the exact child authority at acquisition; both
  // append sites go through the declarative fenced append API, which
  // re-verifies the exact lease generation under the lease mutex. No
  // caller-supplied callback crosses the authority boundary per call.
  assert.match(
    startupSource,
    /getSessionAuthorityManager\(\)\.acquireSessionAppender\(\s*childSessionId,\s*childSessionFile,\s*sessionManager,\s*\)/,
  );
  assert.match(
    startupSource,
    /authority\.appendSessionEntries\(\[[\s\S]*?\{ kind: "custom_entry", customType: SUBAGENT_META_TYPE, data: metadata \}[\s\S]*?\{ kind: "session_info", name: metadata\.description \}/,
  );
  assert.match(
    completionSource,
    /authority\.appendSessionEntries\(\[[\s\S]*?\{ kind: "custom_entry", customType: SUBAGENT_RESULT_TYPE, data: persisted \}/,
  );
  // No per-call appender is passed at either site.
  assert.doesNotMatch(startupSource, /appendSessionEntries\(sessionManager/);
  assert.doesNotMatch(completionSource, /appendSessionEntries\(sessionManager/);
  // Each site appends exactly once: a failed sequence is never retried, so
  // entries cannot be duplicated.
  assert.equal(startupSource.split("appendSessionEntries").length - 1, 1);
  assert.equal(completionSource.split("appendSessionEntries").length - 1, 1);
  // The startup append precedes child-runtime construction and wrapper
  // publication: a failed append can never publish a wrapper.
  assert.ok(
    startupSource.indexOf("authority.appendSessionEntries([")
      < startupSource.indexOf("createAgentSessionFromServices"),
    "the fenced startup append must precede child-runtime construction",
  );
  assert.ok(
    startupSource.indexOf("createAgentSessionFromServices")
      < startupSource.indexOf("dependencies.registerSession(inner"),
    "wrapper publication must follow child-runtime construction",
  );
  // No check-then-write remains at either site.
  assert.doesNotMatch(startupSource, /isHeld\(\)/);
  assert.doesNotMatch(completionSource, /isHeld\(\)/);
  // No arbitrary callback API remains anywhere in the runtime.
  assert.doesNotMatch(source, /runFencedMutation/);
});
