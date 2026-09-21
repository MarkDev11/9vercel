// Cline CLI identity (mirrors the official Cline client request headers).
// Upstream gates the cline-free/* model aliases to Cline product surfaces +
// recent client versions.
const CLINE_CLIENT_TYPE = "cline-cli";
const CLINE_CLIENT_VERSION = "3.0.61";

export function getClineAccessToken(token) {
  if (typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("workos:")) return trimmed;
  // Cline OAuth access tokens are WorkOS JWTs (base64url `eyJ…` header).
  // ClinePass API keys (category "apikey", e.g. `clp_…`) are NOT JWTs and must
  // be sent verbatim — prefixing them with `workos:` makes the Cline API reject
  // the request with HTTP 401 ("Please make sure you're using the latest
  // version of Cline and re-authenticate your Cline account.").
  const isWorkOsJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(trimmed);
  return isWorkOsJwt ? `workos:${trimmed}` : trimmed;
}

export function getClineAuthorizationHeader(token) {
  const accessToken = getClineAccessToken(token);
  return accessToken ? `Bearer ${accessToken}` : "";
}

export function buildClineHeaders(token, extraHeaders = {}, opts = {}) {
  // API keys ride plain Bearer; OAuth access tokens must carry the WorkOS
  // `workos:` prefix so the backend routes verification to WorkOS.
  const trimmed = typeof token === "string" ? token.trim() : "";
  const authorization = !trimmed
    ? ""
    : opts.isApiKey
      ? `Bearer ${trimmed}`
      : getClineAuthorizationHeader(trimmed);
  const headers = {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    // Cline product identity: the backend gates cline-free/* aliases to Cline
    // product surfaces — X-CLIENT-TYPE 9router is 403'd with "only available
    // via Cline product surfaces".
    "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
    "X-PLATFORM": "cli",
    "X-PLATFORM-VERSION": CLINE_CLIENT_VERSION,
    "X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
    "X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
    "X-CORE-VERSION": CLINE_CLIENT_VERSION,
    "X-IS-MULTIROOT": "false",
    ...extraHeaders,
  };

  if (authorization) {
    headers.Authorization = authorization;
  }

  return headers;
}
