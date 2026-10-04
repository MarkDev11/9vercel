import { NextResponse } from "next/server";
import { proxy as dashboardProxy, isAuthenticated } from "./dashboardGuard";
import {
  sessionFromRequest,
  isAccountProxyPath,
  isMimoTakeoverPath,
  takeoverUpstreamPath,
  proxyAccountRequest,
  runTakeover,
  attachSessionCookie,
  originOf,
} from "./lib/mimoLoginSession";

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
  // Xiaomi account session-login proxy (src/lib/mimoLoginSession.js).
  // Session state (region + accumulated cookie jar) travels in the httpOnly
  // 9r_mimo_login cookie — route handlers and this proxy run in separate
  // bundles, so module-level maps are NOT shared. The cookie is only set by
  // the auth-gated login/start route, and the branch below ALSO requires a
  // valid dashboard session: a forged 9r_mimo_login cookie (client-controlled
  // header, unsigned payload) must never turn the app into an unauthenticated
  // forwarder. No URL-carried session — it would leak the jar via history/logs/Referer.
  const cookies = request.headers.get("cookie") || "";
  const hasSessionCookie = cookies.includes("9r_mimo_login=");
  const { pathname } = request.nextUrl;
  if (hasSessionCookie && !(await isAuthenticated(request))) {
    // Forged or stale session cookie without dashboard auth — drop it early.
    const res = await dashboardProxy(request);
    const headers = new Headers(res.headers);
    headers.append("Set-Cookie", "9r_mimo_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  if (!hasSessionCookie && /^\/(fe\/|pass)/.test(pathname) && !pathname.startsWith("/_next")) {
    // Anomaly: a login-flow XHR arrived without the session — the classic
    // cause of silent SPA "Something went wrong" 404s. Narrow to login paths
    // so unrelated unknown routes don't spam this.
    console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] no-session ${pathname} (cookie header: ${cookies ? cookies.slice(0, 80) : "<none>"})`);
  }
  if (hasSessionCookie) {
    const sess = sessionFromRequest(request);
    if (sess) {
      const origin = originOf(request);
      try {
        if (isMimoTakeoverPath(pathname)) {
          const upstreamUrl = `${sess.upstreamBase}${takeoverUpstreamPath(pathname)}${request.nextUrl.search || ""}`;
          return attachSessionCookie(await runTakeover(sess, upstreamUrl, origin), sess);
        }
        if (isAccountProxyPath(pathname)) {
          return attachSessionCookie(await proxyAccountRequest(sess, request, origin), sess);
        }
      } catch (e) {
        console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] proxy error:`, e?.message || e);
        return new Response("mimo login proxy error", { status: 502 });
      }
    } else {
      // Anomaly (should not happen in a healthy flow): cookie present but unparseable.
      console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] session cookie undecodable — falling through (${pathname})`);
    }
  }

  // Cookie present but expired/invalid — clear it on the way past.
  if (hasSessionCookie) {
    const res = await dashboardProxy(request);
    const headers = new Headers(res.headers);
    headers.append("Set-Cookie", "9r_mimo_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  const res = await dashboardProxy(request);
  // Fork: forward stamped real-IP headers downstream when the guard passes.
  if (stamped && isNextResponse(res)) {
    return NextResponse.next({
      request: { headers: request.headers },
    });
  }
  return res;
}

export const config = {
  // Skip the auth/DB middleware for static assets — serving them never needs
  // getSettings()/validateApiKey() and must not pay a Supabase roundtrip.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|avif|css|js|map|txt|xml|webmanifest|woff2?)$).*)"],
};
