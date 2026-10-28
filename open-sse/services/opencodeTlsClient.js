// TLS-impersonating HTTP client for opencode.ai's free tier.
//
// The free gate keys on the TLS ClientHello, not on headers: a request that
// passes from the OpenCode CLI is refused with 429 FreeUsageLimitError when the
// same body/headers ride Node's OpenSSL fingerprint, and passes again once the
// cipher list matches. Measured 2026-10-26 on one process, one egress IP, three
// transports: node fetch/https/http2 all 429, Bun's BoringSSL fetch 200.
// JA4's cipher hash identifies the list (Bun: 5b57614c22b0), so the match is on
// the cipher-list hash and nothing else — reordering the same list still passes.
//
// wreq-js is an optional dependency; when absent the caller keeps its native
// fetch and stays subject to the gate rather than failing the request here.

import { loadRuntimeDep } from "./lazyRuntime.js";

// BoringSSL/Chrome-family cipher list the upstream accepts, in the order Bun
// sends it. Only the list's hash is compared, so this must stay verbatim.
const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const DEFAULT_TIMEOUT_MS = 120000;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

// Sessions are cached per proxy key: wreq-js only accepts `proxy` at session
// creation (session-scoped field — per-request overrides need a `transport`),
// so a rotating proxy pool needs one session per proxy URL. Resetting the
// session on HTTP 429 lets the next attempt dial a fresh connection through
// the pool — a fresh exit IP for rotating upstreams — and self-heal.
const sessionCache = new Map();

function sessionKey(proxyUrl) {
  return typeof proxyUrl === "string" && proxyUrl ? `proxy:${proxyUrl}` : "direct";
}

function buildSessionOptions(proxyUrl) {
  const options = {
    emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
  };
  // `proxy` must sit beside `emulation`, never inside it — wreq-js treats it as
  // a sibling CreateSessionOptions field.
  if (proxyUrl) options.proxy = proxyUrl;
  return options;
}

function loadSession(proxyUrl) {
  const key = sessionKey(proxyUrl);
  if (!sessionCache.has(key)) {
    const pending = (async () => {
      const wreq = await loadRuntimeDep("wreq-js");
      if (typeof wreq.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      return wreq.createSession(buildSessionOptions(proxyUrl));
    })().catch((error) => {
      sessionCache.delete(key);
      throw error;
    });
    sessionCache.set(key, pending);
  }
  return sessionCache.get(key);
}

/** Drop the cached session(s) so the next call builds a fresh one. */
export function resetOpencodeTlsSession(proxyUrl = null) {
  const keys = proxyUrl ? [sessionKey(proxyUrl)] : [...sessionCache.keys()];
  for (const key of keys) {
    const pending = sessionCache.get(key);
    sessionCache.delete(key);
    pending?.then((session) => session.close?.()).catch(() => {});
  }
}

function headersOf(res) {
  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged.
 *
 * Streaming is preserved: the response body is handed over as the live
 * ReadableStream, never buffered.
 *
 * `proxyUrl` routes the request through an HTTP/SOCKS proxy at the session
 * level, keeping the impersonated ClientHello on the proxy path (undici's
 * ProxyAgent dials the tunnel itself, which loses the fingerprint and is
 * refused with 429 FreeUsageLimitError). A 429 additionally drops the cached
 * session so the next request reconnects — self-healing through rotating
 * proxy pools — and the request is retried once on a fresh session.
 */
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, proxyUrl = null, retryOn429 = true } = {}) {
  let session;
  try {
    session = await loadSession(proxyUrl);
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);

  if (res.status === 429) {
    // Drain the (small) error body so the connection can be torn down cleanly.
    await res.text?.().catch?.(() => {});
    resetOpencodeTlsSession(proxyUrl);
    if (retryOn429 && signal && !signal.aborted) {
      try {
        return await opencodeTlsFetch(url, init, { signal, timeoutMs, proxyUrl, retryOn429: false });
      } catch {
        // Retry path failed (e.g. wreq-js dropped out) — surface the 429.
      }
    }
    return new Response("", { status: res.status, statusText: res.statusText, headers: headersOf(res) });
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headersOf(res) });
}

export const __test__ = { OPENCODE_CIPHER_LIST, sessionCache, buildSessionOptions, sessionKey };
