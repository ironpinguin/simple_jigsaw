import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { notifyAdminsOfReport } from "@/lib/report-notify";
import {
  REPORT_CATEGORIES,
  REPORT_MESSAGE_MAX,
  REPORT_MESSAGE_MIN,
  REPORT_RATE_LIMIT,
  REPORT_RATE_WINDOW_MS,
} from "@/lib/reports";
import { hasTrustedProxy, hashReporterIp } from "@/lib/report-ip";

const ReportSchema = z.object({
  puzzleId: z.string().min(1),
  category: z.enum(REPORT_CATEGORIES),
  message: z.string().trim().min(REPORT_MESSAGE_MIN).max(REPORT_MESSAGE_MAX),
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
    select: { title: true, isPublic: true, competition: { select: { puzzleId: true } } },
  });
  if (!puzzle || !puzzle.isPublic) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }
  // A leaderboard name can only be reported where there is a leaderboard — the
  // dialog offers it nowhere else (`categoriesFor`), and neither does this.
  if (parsed.data.category === "NAME" && !puzzle.competition) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
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
  //
  // Only when the hash actually identifies a client, though. Without a trusted
  // proxy every visitor shares one hash, and deduping on that constant would
  // mean the first open report of a puzzle silently swallows everyone else's —
  // an uploader could self-report their own abusive puzzle to mute it. A
  // duplicate row is a far smaller price than a lost report.
  const duplicate = hasTrustedProxy()
    ? await prisma.report.findFirst({
        where: { puzzleId: parsed.data.puzzleId, reporterIpHash: ipHash, status: "OPEN" },
        select: { id: true },
      })
    : null;
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
    // logged, never surfaced to the reporter. Shared with the classifier's own
    // findings (/api/puzzles) so the two cannot drift on who gets told.
    await notifyAdminsOfReport(puzzle.title, parsed.data.category, "user");
  }

  return NextResponse.json({ ok: true });
}
