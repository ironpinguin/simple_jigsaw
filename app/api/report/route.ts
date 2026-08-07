import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { sendReportNotification } from "@/lib/mail";
import {
  REPORT_CATEGORIES,
  REPORT_RATE_LIMIT,
  REPORT_RATE_WINDOW_MS,
  hashReporterIp,
} from "@/lib/reports";

const ReportSchema = z.object({
  puzzleId: z.string().min(1),
  category: z.enum(REPORT_CATEGORIES),
  message: z.string().trim().min(10).max(2000),
  email: z.string().email().optional(),
});

export async function POST(request: Request) {
  const t = await getErrorT();
  const parsed = ReportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }

  // Unknown and private answer the same 404: a stranger cannot see a private
  // puzzle, so they cannot report it — and the endpoint must not confirm that
  // a puzzle id exists (same no-oracle policy as the puzzle routes).
  const puzzle = await prisma.puzzle.findUnique({
    where: { id: parsed.data.puzzleId },
    select: { title: true, isPublic: true },
  });
  if (!puzzle || !puzzle.isPublic) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  const ipHash = hashReporterIp(request.headers.get("x-forwarded-for"));

  const windowStart = new Date(Date.now() - REPORT_RATE_WINDOW_MS);
  const recent = await prisma.report.count({
    where: { reporterIpHash: ipHash, createdAt: { gte: windowStart } },
  });
  if (recent >= REPORT_RATE_LIMIT) {
    return NextResponse.json({ error: t("tooManyReports") }, { status: 429 });
  }

  // Dedup: one open report per puzzle per IP hash. The duplicate case answers
  // exactly like the created case so the endpoint cannot be used to probe
  // "has this IP already reported this puzzle".
  const duplicate = await prisma.report.findFirst({
    where: { puzzleId: parsed.data.puzzleId, reporterIpHash: ipHash, status: "OPEN" },
    select: { id: true },
  });
  if (!duplicate) {
    await prisma.report.create({
      data: {
        puzzleId: parsed.data.puzzleId,
        puzzleTitle: puzzle.title,
        category: parsed.data.category,
        message: parsed.data.message,
        reporterEmail: parsed.data.email ?? null,
        reporterIpHash: ipHash,
      },
    });

    // The queue is the source of truth; the mail is only a ping. Failures are
    // logged, never surfaced to the reporter.
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { email: true },
    });
    await Promise.all(
      admins.map((a) =>
        sendReportNotification(a.email, puzzle.title, parsed.data.category).catch((err) => {
          console.error(`[report] admin notification to ${a.email} failed:`, err);
        }),
      ),
    );
  }

  return NextResponse.json({ ok: true });
}
