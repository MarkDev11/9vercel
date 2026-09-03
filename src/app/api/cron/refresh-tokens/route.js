// Vercel Cron — menggantikan setInterval backgroundTokenRefresh di serverless.
// Dipanggil tiap 15 menit via vercel.json crons. Fail-open: error tidak throw 500.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / belum set — biarkan lewat, tapi log
  const auth = request.headers.get("authorization") || "";
  // Vercel mengirim: Authorization: Bearer <CRON_SECRET>
  if (auth === `Bearer ${secret}`) return true;
  // Fallback: header khusus atau query (untuk manual trigger)
  const headerSecret = request.headers.get("x-cron-secret");
  if (headerSecret && headerSecret === secret) return true;
  return false;
}

export async function GET(request) {
  if (!isAuthorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized cron" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const { runBackgroundTokenRefreshTick } = await import("@/sse/services/backgroundTokenRefresh.js");
    await runBackgroundTokenRefreshTick();
    const elapsed = Date.now() - startedAt;
    return Response.json({ ok: true, elapsedMs: elapsed });
  } catch (e) {
    console.error("[cron/refresh-tokens] failed:", e?.message || e);
    // Fail-open: jangan 500 biar Vercel tidak retry spam — tetap 200 dengan ok:false
    return Response.json({ ok: false, error: e?.message || String(e) }, { status: 200 });
  }
}

// Vercel crons pakai GET, tapi izinkan POST juga untuk manual trigger via dashboard
export async function POST(request) {
  return GET(request);
}
