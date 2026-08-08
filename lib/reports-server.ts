// Server-side report helpers. Separate from lib/reports.ts, which stays pure
// so client components can import the value sets.

import type { ReportDecision } from "./reports";

/**
 * The slice of a Prisma client this needs, so the same call works on
 * `prisma` and on the `tx` client inside an interactive transaction.
 */
interface ReportUpdater {
  report: { updateMany(args: unknown): Promise<{ count: number }> };
}

/**
 * Resolve every OPEN report matching `where` and return how many were
 * resolved. The single owner of the rule that resolving anonymizes: reporter
 * contact and IP hash are only needed while a report is open, and a resolver
 * that forgot one of them would keep that PII with nothing to catch it.
 * Scoping to OPEN also makes the transition a compare-and-set, so two admins
 * racing resolve it exactly once and the loser gets count 0.
 */
export function resolveOpenReports(
  db: ReportUpdater,
  where: { id: string } | { puzzleId: string } | { puzzleId: { in: string[] } },
  status: ReportDecision,
): Promise<number> {
  return db.report
    .updateMany({
      where: { ...where, status: "OPEN" },
      data: {
        status,
        resolvedAt: new Date(),
        reporterEmail: null,
        reporterIpHash: null,
      },
    })
    .then((r) => r.count);
}
