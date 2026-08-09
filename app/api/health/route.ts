import { NextResponse } from "next/server";

// Liveness only. It deliberately touches nothing: a probe that checks the
// database restarts the pod when the database blips, which turns someone
// else's outage into a crashloop. Readiness lives at /api/health/ready.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
