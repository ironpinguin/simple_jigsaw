import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import ReportsAdmin, { type ReportRow } from "@/components/admin/ReportsAdmin";
import { isReportStatus } from "@/lib/reports";

// Per-request page (auth + DB); never prerender/query the DB at build time.
export const dynamic = "force-dynamic";

export default async function AdminReportsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const admin = await requireAdmin();
  if (!admin) redirect(`/${locale}`);

  const open = await prisma.report.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "desc" },
  });
  // The resolved list is the audit view; cap it so the page stays light.
  const resolved = await prisma.report.findMany({
    where: { status: { not: "OPEN" } },
    orderBy: { resolvedAt: "desc" },
    take: 50,
  });

  // Reports have no FK to Puzzle (they survive the takedown), so existence
  // is resolved here in one query.
  const ids = [...new Set([...open, ...resolved].map((r) => r.puzzleId))];
  const existing = new Set(
    (await prisma.puzzle.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
      (p) => p.id,
    ),
  );

  const toRow = (r: (typeof open)[number]): ReportRow => ({
    id: r.id,
    puzzleId: r.puzzleId,
    puzzleTitle: r.puzzleTitle,
    category: r.category,
    message: r.message,
    reporterEmail: r.reporterEmail,
    // The status column is a plain string (SQLite has no enums). Narrow it
    // here so the queue's decision rendering is checked against the union;
    // a value outside it can only have come from a hand-edited row, and
    // showing it as still open is the safe reading.
    status: isReportStatus(r.status) ? r.status : "OPEN",
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    puzzleExists: existing.has(r.puzzleId),
  });

  return <ReportsAdmin initialOpen={open.map(toRow)} initialResolved={resolved.map(toRow)} />;
}
