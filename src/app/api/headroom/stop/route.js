import { NextResponse } from "next/server";
import { stopHeadroomProxy } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function POST() {
  // Fork note (Vercel): no managed child process exists on serverless.
  if (process.env.VERCEL) {
    return NextResponse.json({ error: "Headroom proxy cannot run on Vercel (serverless)" }, { status: 403 });
  }
  try {
    const result = stopHeadroomProxy();
    const status = result.stopped ? 200 : 409;
    return NextResponse.json({ ...result }, { status });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
