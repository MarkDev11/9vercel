import { NextResponse } from "next/server";
import { enableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

const DNS_WARMUP_DELAY_MS = 8000;

export async function POST() {
  // Fork note (Vercel): spawning cloudflared/tailscaled daemons is impossible
  // on serverless — refuse explicitly instead of downloading/spawning binaries.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Tunnel is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const result = await enableTunnel();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor start failed:", error.message));
    // Wait for DNS warmup to propagate at Cloudflare edge after tunnel registered
    await new Promise((r) => setTimeout(r, DNS_WARMUP_DELAY_MS));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel enable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
