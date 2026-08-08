// Server-side report helpers. Separate from lib/reports.ts, which stays pure
// so client components can import the value sets.

import type { ReportDecision } from "./reports";
import { normalizeEmail } from "./bans";

/**
 * The slice of a Prisma client this needs, so the same call works on
 * `prisma` and on the `tx` client inside an interactive transaction.
 */
interface ReportUpdater {
  report: { updateMany(args: unknown): Promise<{ count: number }> };
}

/** As above, plus the read `anonymizeReportsBy` needs. */
interface ReportReader extends ReportUpdater {
  report: ReportUpdater["report"] & {
    findMany(args: unknown): Promise<{ id: string; reporterEmail: string | null }[]>;
  };
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

/**
 * Strip the reporter's contact from every report a given address filed, and
 * return how many were changed. For erasing an account: reports it filed
 * against *other people's* puzzles hold that person's email and IP hash, and
 * `resolveOpenReports` never reaches them — it scopes by puzzle.
 *
 * The status is deliberately left alone. Those reports are about content that
 * is not going anywhere, so an open one stays open and stays in the admin
 * queue; only the reporter's contact goes. Follow-up questions become
 * impossible, which is the erasure working as intended.
 *
 * Matching is done in JS rather than with a `mode: "insensitive"` filter:
 * `reporterEmail` is stored exactly as the reporter typed it while
 * `User.email` is normalized, and Prisma only supports case-insensitive
 * filters on PostgreSQL — this has to work on SQLite too.
 */
export async function anonymizeReportsBy(db: ReportReader, email: string): Promise<number> {
  const target = normalizeEmail(email);
  const candidates = await db.report.findMany({
    where: { reporterEmail: { not: null } },
    select: { id: true, reporterEmail: true },
  });
  const ids = candidates
    .filter((r) => r.reporterEmail !== null && normalizeEmail(r.reporterEmail) === target)
    .map((r) => r.id);
  if (ids.length === 0) return 0;

  const { count } = await db.report.updateMany({
    where: { id: { in: ids } },
    data: { reporterEmail: null, reporterIpHash: null },
  });
  return count;
}
