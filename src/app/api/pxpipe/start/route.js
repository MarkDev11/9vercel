import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getInstallInfo, installPxpipe } from "@/lib/pxpipe/install.js";
import { loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// "Start" in library mode = warm the in-process transform module.
// Auto-installs first when the package is missing and pxpipeAutoInstall is on.
export async function POST() {
  // Fork note (Vercel): the package can never be installed on serverless
  // (install route is 403, /tmp is ephemeral) and auto-install would spawn
  // npm into a read-only FS — refuse explicitly like the install route.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "PXPIPE is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    if (!getInstallInfo().installed) {
      const settings = await getSettings();
      if (!settings.pxpipeAutoInstall) {
        return NextResponse.json({ error: "PXPIPE is not installed", code: "NOT_INSTALLED" }, { status: 409 });
      }
      await installPxpipe();
    }
    await loadPxpipe();
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    // Fork note (Vercel): /tmp is ephemeral and npm is unavailable on
    // serverless, so install failures are expected states (409/503), not 500s.
    const status = error.code === "NOT_INSTALLED" ? 409
      : ["NPM_NOT_FOUND", "EACCES", "EROFS", "ENOSPC"].includes(error.code) || /npm|install|EROFS|ENOSPC|read-only/i.test(error.message || "")
        ? 503
        : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
