import { NextResponse } from "next/server";
import { installPxpipe } from "@/lib/pxpipe/install.js";
import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { runHealthCheck } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";
// npm install can legitimately take minutes on a cold cache.
export const maxDuration = 300;

// Install (or repair — same operation, reinstalls @latest) then re-run the health check.
// Fork note (Vercel): npm-installing a package into DATA_DIR at request time is
// impossible on read-only serverless — refuse explicitly instead of spawning npm.
export async function POST() {
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "PXPIPE install is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const info = await installPxpipe();
    unloadPxpipe(); // drop any previously-loaded version so health loads the fresh one
    const health = await runHealthCheck();
    return NextResponse.json({ ...info, health });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
