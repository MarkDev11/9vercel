import { NextResponse } from "next/server";
import { unloadPxpipe, loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getInstallInfo } from "@/lib/pxpipe/install.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// Reload the in-process module (picks up an upgraded install without a server restart).
export async function POST() {
  try {
    // Mirror the start route: restarting without an install is NOT_INSTALLED (409),
    // not a server error — on Vercel /tmp is ephemeral so this is the common case.
    if (!getInstallInfo().installed) {
      return NextResponse.json({ error: "PXPIPE is not installed", code: "NOT_INSTALLED" }, { status: 409 });
    }
    unloadPxpipe();
    await loadPxpipe();
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" ? 409 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
