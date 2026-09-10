import { SessionAuthorityError } from "./session-authority";

// ============================================================================
// External-owner delegation
//
// When PI_WEB_EXTERNAL_OWNER_URL is configured, the configured official Pi
// Web process is the sole mutation authority for every session: SST never
// creates or retains a local writable AgentSession, and every mutating
// operation (commands, new sessions, rename, delete, auto-name, running
// state, SSE) is delegated to that process over HTTP. There is no local
// fallback: an unreachable or unverifiable authority fails closed.
//
// The delegation target is always the configured base URL plus a fixed
// route suffix; the session id is path-escaped. Redirects are not followed,
// so the upstream can never steer the proxy to another host. This is an
// explicit single-owner proxy, not a generic SSRF surface.
// ============================================================================

export const EXTERNAL_OWNER_DELEGATION_TIMEOUT_MS = 60_000;

/**
 * Marker set on every delegated request so a misconfigured delegation loop
 * (the configured URL pointing back at this instance) fails closed instead
 * of recursing until timeout.
 */
export const DELEGATION_MARKER_HEADER = "x-pi-web-delegation";

/** True when this request is itself a delegation from another Pi Web instance. */
export function isDelegatedRequest(req: Request): boolean {
  return req.headers.get(DELEGATION_MARKER_HEADER) === "1";
}

/** True when an external owner is configured at all (even if invalid). */
export function isExternalOwnerMode(): boolean {
  const raw = process.env.PI_WEB_EXTERNAL_OWNER_URL;
  return raw !== undefined && raw !== "";
}

/**
 * The validated base URL of the configured external owner. Throws
 * SessionAuthorityError("authority_unverifiable") when the variable is set
 * but not a usable http(s) URL, so callers fail closed on misconfiguration.
 */
export function getExternalOwnerBaseUrl(): string {
  const raw = process.env.PI_WEB_EXTERNAL_OWNER_URL;
  if (raw === undefined || raw === "") {
    throw new SessionAuthorityError(
      "authority_unverifiable",
      "No external Pi Web owner is configured",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SessionAuthorityError(
      "authority_unverifiable",
      `PI_WEB_EXTERNAL_OWNER_URL is not a valid URL: ${raw}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SessionAuthorityError(
      "authority_unverifiable",
      `PI_WEB_EXTERNAL_OWNER_URL must be an http(s) URL: ${raw}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new SessionAuthorityError(
      "authority_unverifiable",
      "PI_WEB_EXTERNAL_OWNER_URL must not contain credentials",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new SessionAuthorityError(
      "authority_unverifiable",
      "PI_WEB_EXTERNAL_OWNER_URL must not contain a query or fragment",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Delegate one request to the configured external owner. The path must be a
 * fixed route suffix (session ids are escaped by the caller). The upstream
 * status/body are returned untouched; the client's signal is forwarded so a
 * disconnect cancels the upstream request/stream. Any network failure,
 * timeout, or invalid configuration throws SessionAuthorityError — callers
 * must fail closed and never fall back to local mutation.
 */
export async function delegateExternalOwnerRequest(
  path: string,
  init: RequestInit & { timeoutMs?: number; bodyTimeoutMs?: number } = {},
): Promise<Response> {
  const baseUrl = getExternalOwnerBaseUrl();
  const { timeoutMs, bodyTimeoutMs, ...fetchInit } = init;
  const timeout = timeoutMs ?? EXTERNAL_OWNER_DELEGATION_TIMEOUT_MS;
  const bodyTimeout = bodyTimeoutMs ?? timeout;
  const controller = new AbortController();
  const timer = timeout > 0
    ? setTimeout(() => controller.abort(), timeout)
    : null;
  const signal = fetchInit.signal
    ? AbortSignal.any([fetchInit.signal, controller.signal])
    : controller.signal;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...fetchInit,
      headers: {
        ...(fetchInit.headers as Record<string, string> | undefined),
        [DELEGATION_MARKER_HEADER]: "1",
      },
      signal,
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    if (fetchInit.signal?.aborted) throw error;
    throw new SessionAuthorityError(
      "authority_unverifiable",
      `Cannot reach the configured Pi Web process (${baseUrl}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  if (bodyTimeout > 0 && response.body) {
    // Bound the body too: a stalled upstream must fail closed instead of
    // hanging the caller. SSE callers pass bodyTimeoutMs: 0 so the stream
    // stays open indefinitely.
    const reader = response.body.getReader();
    // Single terminal state for the downstream stream: once the stream is
    // closed, errored, or cancelled, a pending read settling afterward must
    // perform no enqueue/close/error and must not surface a second failure.
    let terminal = false;
    let upstreamCleaned = false;
    const cleanupUpstream = () => {
      if (upstreamCleaned) return;
      upstreamCleaned = true;
      // Abort the underlying fetch and cancel the reader exactly once so a
      // stalled upstream cannot leak a pending request/socket. The cancel
      // promise rejects with the abort reason; swallow it (the stream is
      // already terminal).
      controller.abort();
      void reader.cancel().catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        const bodyTimer = setTimeout(() => {
          if (terminal) return;
          terminal = true;
          cleanupUpstream();
          streamController.error(new Error("upstream body timeout"));
        }, bodyTimeout);
        try {
          const { value, done } = await reader.read();
          if (terminal) return; // timeout/cancel won the race: no enqueue/close/error
          if (done) {
            terminal = true;
            streamController.close();
            return;
          }
          streamController.enqueue(value);
        } catch (error) {
          if (terminal) return; // read rejected after timeout/cancel: swallow it
          terminal = true;
          streamController.error(error);
        } finally {
          clearTimeout(bodyTimer);
        }
      },
      cancel() {
        // Downstream cancellation must also abort the upstream fetch: a
        // reader cancel that rejects would otherwise leave the upstream
        // request/socket running. Abort is idempotent, and the terminal
        // guard makes cancellation idempotent too.
        if (terminal) return;
        terminal = true;
        cleanupUpstream();
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }
  return response;
}

/** Copy the upstream status and body, keeping only the content type. */
export function forwardExternalOwnerResponse(upstream: Response): Response {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Response(upstream.body, { status: upstream.status, headers });
}
