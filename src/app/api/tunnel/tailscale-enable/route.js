import { NextResponse } from "next/server";
import { enableTailscale } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

export async function POST() {
  // Fork note (Vercel): spawning the tailscaled daemon is impossible on
  // serverless — refuse explicitly instead of downloading/spawning binaries.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Tailscale is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const result = await enableTailscale();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tailscale monitor start failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tailscale enable error:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
