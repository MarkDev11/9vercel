import { NextResponse } from "next/server";
import { proxy as dashboardProxy } from "./dashboardGuard";

// Vercel/serverless: Next tidak bisa baca TCP socket, jadi IP asli ada di
// x-forwarded-for (diset oleh Vercel Edge). Replikasi stempel custom-server.js
// agar loginLimiter (hasTrustedPeerHeaders) percaya x-9r-real-ip.
// Self-host (custom-server.js): sudah di-stamp dari socket, blok ini no-op.
function maybeStampVercelIp(request) {
  const existingToken = request.headers.get("x-9r-peer-token");
  const expectedToken = process.env.NINEROUTER_PEER_TOKEN;
  if (expectedToken && existingToken === expectedToken) return false;

  const xff = request.headers.get("x-forwarded-for");
  const xRealIp = request.headers.get("x-real-ip");
  const viaProxy = Boolean(xff || xRealIp);
  const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
  const fallbackIp = request.ip || "";
  const ip = proxyIp || fallbackIp;
  if (!ip) return false;

  // Mutasi in-place — downstream dashboardGuard / loginLimiter baca dari request yang sama
  request.headers.set("x-9r-real-ip", ip);
  if (viaProxy) request.headers.set("x-9r-via-proxy", "1");
  else request.headers.delete("x-9r-via-proxy");
  if (expectedToken) request.headers.set("x-9r-peer-token", expectedToken);
  else if (process.env.VERCEL) request.headers.set("x-9r-peer-token", "vercel-middleware");
  else request.headers.delete("x-9r-peer-token");
  return true;
}

function isNextResponse(res) {
  // NextResponse.next() ditandai header x-middleware-next: 1
  // Blokir (401/403/redirect) tidak punya header ini
  return res?.headers?.get("x-middleware-next") === "1" || res?.headers?.get("x-middleware-next") === 1;
}

export default async function proxy(request) {
  const stamped = maybeStampVercelIp(request);
  const res = await dashboardProxy(request);
  // Jika di-stamp dan guard mengizinkan (next), teruskan header request yang sudah
  // di-stamp ke downstream route handler via NextResponse.next({ request: { headers } }).
  if (stamped && isNextResponse(res)) {
    return NextResponse.next({
      request: { headers: request.headers },
    });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
