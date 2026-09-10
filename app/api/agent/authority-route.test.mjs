import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: postAgentCommand, GET: getAgentState } = await jiti.import("./[id]/route.ts");
const { GET: getAgentEvents } = await jiti.import("./[id]/events/route.ts");
const { POST: postNewSession } = await jiti.import("./new/route.ts");
const { GET: getRunning } = await jiti.import("./running/route.ts");
const { GET: getSessionState } = await jiti.import("../sessions/[id]/state/route.ts");
const { PATCH: patchSession, DELETE: deleteSession } = await jiti.import("../sessions/[id]/route.ts");
const { POST: postAutoName } = await jiti.import("../sessions/[id]/auto-name/route.ts");
const { getRpcSession } = await jiti.import("../../../lib/rpc-manager.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { sessionLeasePath } = await jiti.import("../../../lib/session-authority.ts");
const { invalidateSessionListCache } = await jiti.import("../../../lib/session-reader.ts");

const decoder = new TextDecoder();

async function readWithin(reader, timeoutMs = 2_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Read the next non-comment SSE data message, coalescing chunks. */
function createSseReader(reader) {
  let buffer = "";
  return async function readSseMessage() {
    for (;;) {
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const message = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (message.startsWith("data: ")) return JSON.parse(message.slice("data: ".length));
      }
      const { value, done } = await readWithin(reader);
      if (done) throw new Error("SSE stream ended");
      buffer += decoder.decode(value);
    }
  };
}

async function withSessionEnv(run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-authority-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOwnerUrl = process.env.PI_WEB_EXTERNAL_OWNER_URL;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  try {
    await run(dir);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOwnerUrl === undefined) delete process.env.PI_WEB_EXTERNAL_OWNER_URL;
    else process.env.PI_WEB_EXTERNAL_OWNER_URL = previousOwnerUrl;
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  }
}

function createSessionFile(dir, cwd, firstMessage) {
  const manager = SessionManager.create(cwd, join(dir, "sessions", "cwd"));
  manager.appendMessage({ role: "user", content: firstMessage, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Already finished" }],
    timestamp: Date.now(),
  });
  return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() };
}

function createChildSessionFile(dir, cwd, parentSessionFile) {
  const manager = SessionManager.create(cwd, join(dir, "sessions", "cwd"), {
    parentSession: parentSessionFile,
  });
  manager.appendMessage({ role: "user", content: "child", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    timestamp: Date.now(),
  });
  return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() };
}

function startExternalServer(handlers) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const handler = handlers[`${method} ${url.pathname}`]
      ?? Object.entries(handlers).find(([pattern]) => {
        if (!pattern.startsWith("RE ")) return false;
        const [pMethod, pPath] = pattern.slice(3).split(" ");
        return pMethod === method && new RegExp(pPath).test(url.pathname);
      })?.[1];
    if (!handler) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end("{}");
      return;
    }
    handler(req, res, url);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function jsonHandler(body) {
  return (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

function echoBodyHandler(extra = {}) {
  return (req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data: { received: JSON.parse(raw), ...extra } }));
    });
  };
}

function rawSseHandler(chunks) {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) res.write(chunk);
    res.end();
  };
}

// ============================================================================
// External-owner mode: everything is delegated to the configured official
// process; no local writable AgentSession may exist.
// ============================================================================

test("external-owner mode delegates commands and never creates a local session", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");
    const before = await readFile(sessionFile, "utf8");

    const server = await startExternalServer({
      "RE POST /api/agent/[^/]+$": echoBodyHandler(),
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const response = await postAgentCommand(
      new Request(`http://localhost/api/agent/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "delegated" }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.received.type, "prompt");
    assert.equal(body.data.received.message, "delegated");

    // The local JSONL is untouched and no local writable session exists.
    assert.equal(await readFile(sessionFile, "utf8"), before);
    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("external-owner mode delegates state, running, and session-state reads", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId } = createSessionFile(dir, cwd, "hello");

    const server = await startExternalServer({
      "RE GET /api/agent/[^/]+$": jsonHandler({ running: true, state: { isStreaming: true } }),
      "RE GET /api/sessions/[^/]+/state$": jsonHandler({ running: false, state: { isPromptRunning: false }, readOnly: false }),
      "GET /api/agent/running": jsonHandler({ runningSessionIds: ["s1"] }),
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const state = await getAgentState(
      new Request(`http://localhost/api/agent/${sessionId}`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), { running: true, state: { isStreaming: true } });

    const sessionState = await getSessionState(
      new Request(`http://localhost/api/sessions/${sessionId}/state`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(sessionState.status, 200);
    assert.deepEqual(await sessionState.json(), {
      running: false,
      state: { isPromptRunning: false },
      readOnly: true,
      authority: "external_owner",
    });

    const running = await getRunning(new Request("http://localhost/api/agent/running"));
    assert.equal(running.status, 200);
    assert.deepEqual(await running.json(), { runningSessionIds: ["s1"] });

    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("external-owner state fails closed for malformed or non-object authority responses", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId } = createSessionFile(dir, cwd, "hello");
    let upstreamBody = "{";
    const server = await startExternalServer({
      "RE GET /api/sessions/[^/]+/state$": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(upstreamBody);
      },
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    for (const body of ["{", "[]"]) {
      upstreamBody = body;
      const response = await getSessionState(
        new Request(`http://localhost/api/sessions/${sessionId}/state`),
        { params: Promise.resolve({ id: sessionId }) },
      );
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), {
        error: "The configured Pi Web process returned invalid session state; the session is read-only here.",
        code: "authority_required",
        authority: "authority_unverifiable",
      });
    }
  });
});
test("external-owner mode delegates new-session creation", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const server = await startExternalServer({
      "POST /api/agent/new": echoBodyHandler({ sessionId: "external-new-id" }),
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const response = await postNewSession(
      new Request("http://localhost/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, type: "ensure_session" }),
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.received.cwd, cwd);
    assert.equal(body.data.sessionId, "external-new-id");

    // No local session was created for the new id either.
    assert.equal(getRpcSession("external-new-id"), undefined);
  });
});

test("external-owner mode delegates rename and delete", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");
    const before = await readFile(sessionFile, "utf8");

    const server = await startExternalServer({
      "RE PATCH /api/sessions/[^/]+$": echoBodyHandler(),
      "RE DELETE /api/sessions/[^/]+$": jsonHandler({ ok: true }),
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const renameResponse = await patchSession(
      new Request(`http://localhost/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(renameResponse.status, 200);
    assert.equal((await renameResponse.json()).data.received.name, "Renamed");

    const deleteResponse = await deleteSession(
      new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { ok: true });

    // Neither mutation touched the local JSONL.
    assert.equal(await readFile(sessionFile, "utf8"), before);
    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("external-owner mode proxies the official SSE stream verbatim", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId } = createSessionFile(dir, cwd, "hello");
    const upstreamBody = [
      ": heartbeat\r\n\r\n",
      `data: ${JSON.stringify({ type: "connected", sessionId, isStreaming: false })}\r\n\r\n`,
      ": between\r\n\r\n",
      `data: ${JSON.stringify({ type: "message_end", sessionId, entryId: "e3" })}\r\n\r\n`,
      "data: {\"type\":\"unterminated\"}",
    ].join("");
    const splitAt = upstreamBody.indexOf("\r\n") + 1;
    const chunks = [
      upstreamBody.slice(0, splitAt),
      upstreamBody.slice(splitAt, splitAt + 23),
      upstreamBody.slice(splitAt + 23),
    ];

    const server = await startExternalServer({
      "RE GET /api/agent/[^/]+/events$": rawSseHandler(chunks),
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const response = await getAgentEvents(
      new Request(`http://localhost/api/agent/${sessionId}/events`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from(upstreamBody),
    );
    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("external-owner mode forwards the official's non-ok SSE status", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId } = createSessionFile(dir, cwd, "hello");

    const server = await startExternalServer({
      "RE GET /api/agent/[^/]+/events$": (_req, res) => {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain");
        res.end("Session not found");
      },
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const response = await getAgentEvents(
      new Request(`http://localhost/api/agent/${sessionId}/events`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Session not found");
    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("external-owner mode fails closed when the authority is unreachable", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");
    const before = await readFile(sessionFile, "utf8");
    process.env.PI_WEB_EXTERNAL_OWNER_URL = "http://127.0.0.1:1";

    const response = await postAgentCommand(
      new Request(`http://localhost/api/agent/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "must not be written" }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.code, "authority_required");
    assert.equal(body.authority, "authority_unverifiable");
    // No prompt_rejected marker: the upstream may have accepted the prompt
    // before the connection failed, so the client must not roll back blindly.
    assert.equal(body.accepted, undefined);

    assert.equal(await readFile(sessionFile, "utf8"), before);
    assert.equal(getRpcSession(sessionId), undefined);

    const events = await getAgentEvents(
      new Request(`http://localhost/api/agent/${sessionId}/events`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(events.status, 502);
    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("external-owner mode fails closed for new sessions when unreachable", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    process.env.PI_WEB_EXTERNAL_OWNER_URL = "http://127.0.0.1:1";

    const response = await postNewSession(
      new Request("http://localhost/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, type: "ensure_session" }),
      }),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "authority_required");
  });
});

test("a delegated request is rejected so a misconfigured loop fails closed", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId } = createSessionFile(dir, cwd, "hello");

    // The configured owner points back at this instance: the marker header
    // must be rejected before any delegation, so the request cannot recurse.
    const server = await startExternalServer({
      "RE POST /api/agent/[^/]+$": (_req, res) => {
        res.statusCode = 500;
        res.end("must never be reached");
      },
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;

    const response = await postAgentCommand(
      new Request(`http://localhost/api/agent/${sessionId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pi-web-delegation": "1",
        },
        body: JSON.stringify({ type: "prompt", message: "loop" }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "authority_required");
    assert.equal(getRpcSession(sessionId), undefined);
  });
});

test("a spoofed delegation marker is rejected by every external-mode route before local execution", async (t) => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");
    const before = await readFile(sessionFile, "utf8");

    // The marker is client-controlled; every external-mode route must reject
    // it with 502 before any local mutation or delegation, so it can never
    // be used to skip the sole-owner boundary or execute locally.
    const server = await startExternalServer({
      "RE .*": (_req, res) => {
        res.statusCode = 500;
        res.end("must never be reached");
      },
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    process.env.PI_WEB_EXTERNAL_OWNER_URL = `http://127.0.0.1:${server.address().port}`;
    const marker = { "x-pi-web-delegation": "1" };
    const params = { params: Promise.resolve({ id: sessionId }) };

    const cases = [
      ["POST /api/agent/[id]", postAgentCommand(new Request(`http://localhost/api/agent/${sessionId}`, { method: "POST", headers: { ...marker, "Content-Type": "application/json" }, body: JSON.stringify({ type: "prompt", message: "x" }) }), params)],
      ["GET /api/agent/[id]", getAgentState(new Request(`http://localhost/api/agent/${sessionId}`, { headers: marker }), params)],
      ["GET /api/agent/[id]/events", getAgentEvents(new Request(`http://localhost/api/agent/${sessionId}/events`, { headers: marker }), params)],
      ["POST /api/agent/new", postNewSession(new Request("http://localhost/api/agent/new", { method: "POST", headers: { ...marker, "Content-Type": "application/json" }, body: JSON.stringify({ cwd, type: "ensure_session" }) }))],
      ["GET /api/agent/running", getRunning(new Request("http://localhost/api/agent/running", { headers: marker }))],
      ["GET /api/sessions/[id]/state", getSessionState(new Request(`http://localhost/api/sessions/${sessionId}/state`, { headers: marker }), params)],
      ["PATCH /api/sessions/[id]", patchSession(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "PATCH", headers: { ...marker, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Spoofed" }) }), params)],
      ["DELETE /api/sessions/[id]", deleteSession(new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE", headers: marker }), params)],
      ["POST /api/sessions/[id]/auto-name", postAutoName(new Request(`http://localhost/api/sessions/${sessionId}/auto-name`, { method: "POST", headers: { ...marker, "Content-Type": "application/json" }, body: "{}" }), params)],
    ];

    for (const [name, promise] of cases) {
      const response = await promise;
      assert.equal(response.status, 502, `${name}: expected 502`);
      if (name === "GET /api/agent/[id]/events") {
        assert.equal(await response.text(), "Delegation loop detected");
      } else {
        assert.equal((await response.json()).code, "authority_required", `${name}: expected authority_required`);
      }
    }

    // No local mutation happened: the JSONL is untouched and no local
    // writable session exists for any id.
    assert.equal(await readFile(sessionFile, "utf8"), before);
    assert.equal(getRpcSession(sessionId), undefined);
    assert.equal(getRpcSession("external-new-id"), undefined);
  });
});

// ============================================================================
// Standalone mode: the sidecar lease coordinates SST processes.
// ============================================================================

test("a session leased by another process fails closed", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");
    const before = await readFile(sessionFile, "utf8");

    // Simulate another SST process holding a fresh lease.
    await writeFile(
      sessionLeasePath(sessionFile),
      `${JSON.stringify({
        ownerId: "11111111-2222-3333-4444-555555555555",
        sessionId,
        sessionFile,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        version: 1,
        token: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      })}\n`,
    );

    const response = await postAgentCommand(
      new Request(`http://localhost/api/agent/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "must not be written" }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.authority, "lease_held");
    assert.equal(await readFile(sessionFile, "utf8"), before);
  });
});

test("the events route serves a read-only observer for a lease-held session", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");

    await writeFile(
      sessionLeasePath(sessionFile),
      `${JSON.stringify({
        ownerId: "11111111-2222-3333-4444-555555555555",
        sessionId,
        sessionFile,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        version: 1,
        token: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      })}\n`,
    );

    const response = await getAgentEvents(
      new Request(`http://localhost/api/agent/${sessionId}/events`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const readSseMessage = createSseReader(reader);

    const connected = await readSseMessage();
    assert.equal(connected.type, "connected");
    assert.equal(connected.mode, "observer");
    assert.equal(connected.sessionId, sessionId);

    const snapshot = await readSseMessage();
    assert.equal(snapshot.type, "session_snapshot");
    assert.equal(snapshot.sessionId, sessionId);
    assert.equal(snapshot.snapshot.context.messages.length, 2);

    await reader.cancel();
  });
});

test("the events route serves a writable stream when authority is provable", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId } = createSessionFile(dir, cwd, "hello");

    const response = await getAgentEvents(
      new Request(`http://localhost/api/agent/${sessionId}/events`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const readSseMessage = createSseReader(reader);

    const connected = await readSseMessage();
    assert.equal(connected.type, "connected");
    assert.equal(connected.mode, undefined);
    assert.equal(connected.isStreaming, false);

    await reader.cancel();
    // Shut down the wrapper the cold start created so its timers do not keep
    // the test process alive.
    await getRpcSession(sessionId)?.shutdown();
  });
});

test("standalone delete rejects a session with children before any write", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const parent = createSessionFile(dir, cwd, "parent");
    const child = createChildSessionFile(dir, cwd, parent.sessionFile);
    const parentBefore = await readFile(parent.sessionFile, "utf8");
    const childBefore = await readFile(child.sessionFile, "utf8");

    const response = await deleteSession(
      new Request(`http://localhost/api/sessions/${parent.sessionId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: parent.sessionId }) },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "delete_blocked_children");

    // No file was touched: the rejection happened before the first write.
    assert.equal(await readFile(parent.sessionFile, "utf8"), parentBefore);
    assert.equal(await readFile(child.sessionFile, "utf8"), childBefore);
  });
});

test("standalone delete removes a childless session atomically", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");

    const response = await deleteSession(
      new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    await assert.rejects(readFile(sessionFile, "utf8"), { code: "ENOENT" });
  });
});

test("standalone delete shuts down a live wrapper and fences the unlink", async () => {
  await withSessionEnv(async (dir) => {
    const cwd = join(dir, "project");
    const { sessionId, sessionFile } = createSessionFile(dir, cwd, "hello");

    // Cold-start a local writable wrapper (holds the lease).
    const events = await getAgentEvents(
      new Request(`http://localhost/api/agent/${sessionId}/events`),
      { params: Promise.resolve({ id: sessionId }) },
    );
    const reader = events.body.getReader();
    await readWithin(reader);
    await readWithin(reader);
    await reader.cancel();
    assert.ok(getRpcSession(sessionId)?.isAlive());

    const response = await deleteSession(
      new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: sessionId }) },
    );
    assert.equal(response.status, 200);

    await assert.rejects(readFile(sessionFile, "utf8"), { code: "ENOENT" });
    assert.equal(getRpcSession(sessionId), undefined);
  });
});
