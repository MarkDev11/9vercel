import { NextResponse } from "next/server";
import { findPython310, getInstalledHeadroomExtras, HEADROOM_COMPRESSION_EXTRAS } from "@/lib/headroom/detect";
import { installHeadroomExtras, uninstallHeadroomExtras, getInstallLogTail } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    // `?log=1` returns the live install/uninstall log tail for progress polling.
    if (new URL(req.url).searchParams.get("log") === "1") {
      return NextResponse.json({ log: getInstallLogTail() });
    }
    const python = findPython310();
    const status = getInstalledHeadroomExtras(python);
    return NextResponse.json({
      available: HEADROOM_COMPRESSION_EXTRAS,
      ...status,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  // Fork note (Vercel): pip-installing packages at request time is impossible
  // on read-only serverless — refuse explicitly instead of spawning pip.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Headroom extras install is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body?.extras) ? body.extras : [];
    const result = await installHeadroomExtras(requested);
    return NextResponse.json(result);
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" || error.code === "NO_PYTHON" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}

export async function DELETE(req) {
  // Fork note (Vercel): pip-uninstalling packages at request time is impossible
  // on read-only serverless.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Headroom extras removal is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body?.extras) ? body.extras : [];
    const result = await uninstallHeadroomExtras(requested);
    return NextResponse.json(result);
  } catch (error) {
    const status = error.code === "NO_PYTHON" || error.code === "INVALID_EXTRAS" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
