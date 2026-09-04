import { NextResponse } from "next/server";
import { disableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

export async function POST() {
  // Fork note (Vercel): no tunnel daemon can exist on serverless.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Tunnel is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const result = await disableTunnel();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor update failed:", error.message));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
