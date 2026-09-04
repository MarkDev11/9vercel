import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";

// Shutdown app to release file locks for manual update.
// Fork note (Vercel): serverless functions have no persistent host process —
// killing the process kills only this invocation and recycles a shared worker,
// so refuse explicitly instead of calling process.exit on Vercel.
export async function POST() {
  if (process.env.VERCEL) {
    return NextResponse.json({ success: false, message: "Shutdown is not available on Vercel (serverless)" }, { status: 403 });
  }
  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
