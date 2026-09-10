import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  delegateExternalOwnerRequest,
  isDelegatedRequest,
  isExternalOwnerMode,
  DELEGATION_MARKER_HEADER,
} = await jiti.import("./external-owner.ts");

const decoder = new TextDecoder();

async function withOwnerUrl(baseUrl, run) {
  const previous = process.env.PI_WEB_EXTERNAL_OWNER_URL;
  process.env.PI_WEB_EXTERNAL_OWNER_URL = baseUrl;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_EXTERNAL_OWNER_URL;
    else process.env.PI_WEB_EXTERNAL_OWNER_URL = previous;
  }
}

function startServer(handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolveClose) => server.close(resolveClose));
    },
  })));
}

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("condition not met in time"));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

test("a stalled upstream body aborts the fetch and errors the downstream stream", async (t) => {
  let upstreamClosed = false;
  let sawMarker = false;
  const { server, close } = await startServer((req, res) => {
    sawMarker = req.headers[DELEGATION_MARKER_HEADER] === "1";
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    res.on("close", () => { upstreamClosed = true; });
    // The body stalls: never end the response.
  });
  t.after(close);

  await withOwnerUrl(`http://127.0.0.1:${server.address().port}`, async () => {
    const response = await delegateExternalOwnerRequest("/stall", { bodyTimeoutMs: 100, timeoutMs: 5_000 });
    assert.equal(response.status, 200);
    assert.equal(sawMarker, true);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(decoder.decode(first.value), "partial");

    // The body timeout errors the downstream stream and aborts the
    // underlying fetch: the upstream connection must close (no leaked
    // pending upstream request/socket).
    await assert.rejects(reader.read(), /upstream body timeout/);
    await waitFor(() => upstreamClosed);
  });
});

test("downstream cancellation cancels the upstream reader", async (t) => {
  let upstreamClosed = false;
  const { server, close } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(":\n\n");
    const keepAlive = setInterval(() => res.write(":\n\n"), 50);
    res.on("close", () => { upstreamClosed = true; clearInterval(keepAlive); });
  });
  t.after(close);

  await withOwnerUrl(`http://127.0.0.1:${server.address().port}`, async () => {
    const response = await delegateExternalOwnerRequest("/events", { bodyTimeoutMs: 0, timeoutMs: 5_000 });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(() => upstreamClosed);
  });
});

test("a stalled header handshake fails closed", async (t) => {
  const { server, close } = await startServer(() => {
    // Never respond: the header handshake must be bounded by timeoutMs.
  });
  t.after(close);

  await withOwnerUrl(`http://127.0.0.1:${server.address().port}`, async () => {
    await assert.rejects(
      delegateExternalOwnerRequest("/hang", { timeoutMs: 100 }),
      // The class name is the stable contract across jiti module instances.
      (error) => error?.name === "SessionAuthorityError" && error.code === "authority_unverifiable",
    );
  });
});

test("SSE streams stay open with bodyTimeoutMs: 0", async (t) => {
  let upstreamWrites = 0;
  const { server, close } = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const keepAlive = setInterval(() => { upstreamWrites += 1; res.write(":\n\n"); }, 50);
    res.on("close", () => clearInterval(keepAlive));
  });
  t.after(close);

  await withOwnerUrl(`http://127.0.0.1:${server.address().port}`, async () => {
    const response = await delegateExternalOwnerRequest("/events", { bodyTimeoutMs: 0, timeoutMs: 5_000 });
    const reader = response.body.getReader();
    await reader.read();
    await reader.read();
    // No body timeout fired: the long-lived stream is still open.
    assert.ok(upstreamWrites >= 2, `expected live upstream writes, got ${upstreamWrites}`);
    await reader.cancel();
  });
});

test("delegation marker helpers", () => {
  assert.equal(
    isDelegatedRequest(new Request("http://localhost/x", { headers: { "x-pi-web-delegation": "1" } })),
    true,
  );
  assert.equal(isDelegatedRequest(new Request("http://localhost/x")), false);
  assert.equal(isExternalOwnerMode(), false);
  const previous = process.env.PI_WEB_EXTERNAL_OWNER_URL;
  try {
    process.env.PI_WEB_EXTERNAL_OWNER_URL = "http://127.0.0.1:1";
    assert.equal(isExternalOwnerMode(), true);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_EXTERNAL_OWNER_URL;
    else process.env.PI_WEB_EXTERNAL_OWNER_URL = previous;
  }
});

// ============================================================================
// Deterministic timeout/read/cancel races
// ============================================================================

// A body stream whose pull stays pending until the test settles it, so the
// timeout-vs-read race is fully deterministic. `settled` resolves when the
// pull has finished processing the settled read, so assertions can await an
// explicit settlement signal instead of a fixed delay.
function createControlledBody() {
  let resolveRead;
  let rejectRead;
  let resolveSettled;
  let cancelCount = 0;
  const pending = new Promise((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  const settled = new Promise((resolve) => { resolveSettled = resolve; });
  const body = new ReadableStream({
    pull(controller) {
      return pending.then(
        (value) => {
          try {
            controller.enqueue(value);
          } catch {
            // The stream was cancelled/errored by the fence: the enqueue is
            // a no-op; the pull still settles so the test can observe it.
          }
        },
      ).finally(() => resolveSettled());
    },
    cancel() {
      cancelCount += 1;
    },
  });
  return { body, resolveRead, rejectRead, settled, get cancelCount() { return cancelCount; } };
}

function trackUnhandledRejections(t) {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  return unhandled;
}

async function withMockFetch(response, run) {
  const realFetch = globalThis.fetch;
  let capturedSignal;
  globalThis.fetch = async (_url, init) => {
    capturedSignal = init.signal;
    return response;
  };
  try {
    await run({ getSignal: () => capturedSignal });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a read settling after the body timeout performs no enqueue/close/error", async (t) => {
  const controlled = createControlledBody();
  const unhandled = trackUnhandledRejections(t);

  await withOwnerUrl("http://127.0.0.1:1", async () => {
    await withMockFetch(
      { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: controlled.body },
      async ({ getSignal }) => {
        const response = await delegateExternalOwnerRequest("/stall", { bodyTimeoutMs: 50, timeoutMs: 5_000 });
        const reader = response.body.getReader();
        const readPromise = reader.read(); // pull starts; the upstream read is pending

        // The body timeout wins the race: the downstream stream errors, the
        // fetch is aborted, and the upstream reader is cancelled exactly once.
        await assert.rejects(readPromise, /upstream body timeout/);
        assert.equal(getSignal().aborted, true);
        assert.equal(controlled.cancelCount, 1);

        // The pending upstream read then resolves: it must not enqueue/close
        // on the already-errored stream and must not surface a second failure.
        controlled.resolveRead(new TextEncoder().encode("late"));
        await controlled.settled;
        assert.equal(unhandled.length, 0, `unexpected unhandled rejections: ${unhandled}`);

        // The stream stays errored with the timeout error: no close happened.
        await assert.rejects(reader.read(), /upstream body timeout/);
      },
    );
  });
});

test("a read rejecting after the body timeout is swallowed exactly once", async (t) => {
  const controlled = createControlledBody();
  const unhandled = trackUnhandledRejections(t);

  await withOwnerUrl("http://127.0.0.1:1", async () => {
    await withMockFetch(
      { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: controlled.body },
      async ({ getSignal }) => {
        const response = await delegateExternalOwnerRequest("/stall", { bodyTimeoutMs: 50, timeoutMs: 5_000 });
        const reader = response.body.getReader();
        const readPromise = reader.read();

        await assert.rejects(readPromise, /upstream body timeout/);
        assert.equal(getSignal().aborted, true);
        assert.equal(controlled.cancelCount, 1);

        // The pending upstream read then rejects (abort reason): the timeout
        // is reported exactly once and the read rejection is not surfaced as
        // a second failure.
        controlled.rejectRead(new Error("aborted upstream read"));
        await controlled.settled;
        assert.equal(unhandled.length, 0, `unexpected unhandled rejections: ${unhandled}`);
        await assert.rejects(reader.read(), /upstream body timeout/);
      },
    );
  });
});

test("downstream cancellation while a read is pending cleans up exactly once", async (t) => {
  const controlled = createControlledBody();
  const unhandled = trackUnhandledRejections(t);

  await withOwnerUrl("http://127.0.0.1:1", async () => {
    await withMockFetch(
      { status: 200, headers: new Headers({ "content-type": "text/plain" }), body: controlled.body },
      async ({ getSignal }) => {
        const response = await delegateExternalOwnerRequest("/events", { bodyTimeoutMs: 50, timeoutMs: 5_000 });
        const reader = response.body.getReader();
        const readPromise = reader.read();
        readPromise.catch(() => {}); // a pending read may reject on cancel; that is the stream's own contract

        await reader.cancel();
        assert.equal(getSignal().aborted, true);
        assert.equal(controlled.cancelCount, 1);
        // Downstream cancellation is idempotent: a second cancel cleans up nothing.
        await reader.cancel();
        assert.equal(controlled.cancelCount, 1);

        // The pending read rejects after cancellation: swallowed, no second failure.
        controlled.rejectRead(new Error("cancelled upstream read"));
        await controlled.settled;
        assert.equal(unhandled.length, 0, `unexpected unhandled rejections: ${unhandled}`);

        // The body timeout fires after cancellation: no second error surfaces.
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(unhandled.length, 0, `unexpected unhandled rejections: ${unhandled}`);
      },
    );
  });
});

test("a never-settling upstream cancel does not block the downstream error", async (t) => {
  const unhandled = trackUnhandledRejections(t);
  let cancelCount = 0;
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {}); // the upstream read never settles
    },
    cancel() {
      cancelCount += 1;
      return new Promise(() => {}); // cancellation never settles either
    },
  });

  await withOwnerUrl("http://127.0.0.1:1", async () => {
    await withMockFetch(
      { status: 200, headers: new Headers({ "content-type": "text/plain" }), body },
      async ({ getSignal }) => {
        const response = await delegateExternalOwnerRequest("/stall", { bodyTimeoutMs: 50, timeoutMs: 5_000 });
        const reader = response.body.getReader();

        // The body timeout still errors the downstream stream exactly once and
        // aborts the fetch; the never-settling cancel is fire-and-forget and
        // cannot surface a second failure or block the error.
        await assert.rejects(reader.read(), /upstream body timeout/);
        assert.equal(getSignal().aborted, true);
        assert.equal(cancelCount, 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(unhandled.length, 0, `unexpected unhandled rejections: ${unhandled}`);
      },
    );
  });
});
