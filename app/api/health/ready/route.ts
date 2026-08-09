import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { maybePurgeExpiredTokens } from "@/lib/retention";

// Readiness: can this instance actually serve requests? Kubernetes takes a
// failing pod out of the Service on this, and compose reports the container
// unhealthy. Liveness — which must not depend on the database — is /api/health.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    // Deliberately not logged: a probe runs every few seconds, so this would
    // fill the log at exactly the moment an operator needs to read it. The 503
    // is itself the signal. The body carries no detail either — the endpoint is
    // public and Prisma's connection errors quote the DSN.
    return NextResponse.json({ ok: false, db: "down" }, { status: 503, headers: NO_STORE });
  }

  // Housekeeping rides along on a trigger that exists anyway, throttled to at
  // most one sweep an hour across every caller. It cannot fail the probe: the
  // catch is for a bug in the throttle itself, which handles its own errors.
  await maybePurgeExpiredTokens().catch((error) => {
    console.error("[health] retention sweep threw unexpectedly:", error);
  });

  return NextResponse.json({ ok: true, db: "up" }, { headers: NO_STORE });
}
