import { NextResponse } from "next/server";
import { pingModelByKind } from "./ping";

// POST /api/models/test - Ping a single model via internal completions or embeddings
export async function POST(request) {
  try {
    const { model, kind } = await request.json();
    if (!model) return NextResponse.json({ error: "Model required" }, { status: 400 });
    // Fork note (Vercel): loopback is dead on serverless — probe through the
    // public app URL instead so the request can route to a live instance.
    // Undefined keeps ping's loopback default on self-hosted.
    const baseUrl = process.env.VERCEL ? new URL(request.url).origin : undefined;
    const result = await pingModelByKind(model, kind || "llm", baseUrl);
    return NextResponse.json(result);
  } catch (err) {
    // A probe failure is an expected result, not a server error — return 200
    // with { ok:false } (the Providers UI reads data.ok either way, but a 500
    // also trips error monitoring on Vercel where loopback probes always fail).
    return NextResponse.json({ ok: false, error: err.message });
  }
}
