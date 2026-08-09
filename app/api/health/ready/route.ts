import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { maybePurgeExpiredTokens, retentionStatus } from "@/lib/retention";

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
  // most one sweep an hour across every caller. Deliberately not awaited: the
  // result is unused, and a table-wide DELETE blocked on a lock would otherwise
  // hold the probe past its timeout (5s in the k8s and compose configs). The
  // .catch is for a bug in the throttle itself, which handles its own errors.
  void maybePurgeExpiredTokens().catch((error) => {
    console.error("[health] retention sweep threw unexpectedly:", error);
  });

  // Reported, never fatal: a pod whose sweep is stuck still serves traffic
  // perfectly well, so this must not take it out of the Service. It is here
  // because a failing sweep is otherwise invisible — `SELECT 1` above says
  // nothing about whether the DELETE works.
  const retention = retentionStatus().stale ? "stale" : "ok";

  return NextResponse.json({ ok: true, db: "up", retention }, { headers: NO_STORE });
}
