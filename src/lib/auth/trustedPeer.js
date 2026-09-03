// x-9r-real-ip is only trustworthy when stamped by trusted infrastructure.
// - Local/self-host: custom-server.js stamps from TCP socket + per-process secret NINEROUTER_PEER_TOKEN.
// - Vercel: src/middleware.js stamps from x-forwarded-for (Vercel edge) + peer token or fallback "vercel-middleware".
export function hasTrustedPeerHeaders(request) {
  const token = process.env.NINEROUTER_PEER_TOKEN;
  const headerToken = request.headers.get("x-9r-peer-token");
  if (token && headerToken === token) return true;
  // Vercel fallback when NINEROUTER_PEER_TOKEN not configured — middleware uses "vercel-middleware".
  if (process.env.VERCEL && headerToken === "vercel-middleware") return true;
  return false;
}
