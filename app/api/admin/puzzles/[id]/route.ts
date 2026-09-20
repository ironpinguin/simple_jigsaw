import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { sendTakedownNotice } from "@/lib/mail";
import { isReportCategory } from "@/lib/reports";
import { resolveOpenReports } from "@/lib/reports-server";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const { id } = await params;

  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { imageKey: true, title: true, owner: { select: { email: true, locale: true } } },
  });
  if (!puzzle) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  // A takedown must not leave the image behind: storage goes first, and a
  // storage failure aborts the whole request with the DB row untouched — the
  // admin sees the failure and retries. Deliberately stricter than the
  // owner-facing delete (which only logs): removing the image is the point.
  const stillReferenced = await prisma.puzzle.findFirst({
    where: { imageKey: puzzle.imageKey, id: { not: id } },
    select: { id: true },
  });
  if (!stillReferenced) {
    try {
      await deleteObject(puzzle.imageKey);
    } catch (err) {
      console.error(`[admin] takedown storage delete of ${puzzle.imageKey} failed:`, err);
      return NextResponse.json({ error: t("storageFailed") }, { status: 502 });
    }
  }

  // Row delete and report resolution in one transaction: a failure between
  // them would otherwise leave the puzzle gone but its reports open and
  // un-anonymized (reporter PII retained past resolve), and the admin's
  // retry would hit a misleading 404. One takedown resolves every open
  // report of this puzzle; reporter contact and IP hash are only needed
  // while a report is open (anonymize on resolve).
  const result = await prisma.$transaction(async (tx) => {
    const deleted = await tx.puzzle.deleteMany({ where: { id } });
    if (deleted.count === 0) {
      // Raced with a concurrent delete of the same puzzle.
      return null;
    }
    const openReport = await tx.report.findFirst({
      where: { puzzleId: id, status: "OPEN" },
      select: { category: true },
    });
    await resolveOpenReports(tx, { puzzleId: id }, "TAKEDOWN");
    return { reportedCategory: openReport?.category ?? null };
  });
  if (!result) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  // null when no open report exists (the route works on any puzzle) or the
  // stored value is not canonical — the notice then says "after a review"
  // instead of inventing a reason nobody filed.
  const category =
    result.reportedCategory !== null && isReportCategory(result.reportedCategory)
      ? result.reportedCategory
      : null;
  // The owner's own locale, not the acting admin's: this is the one mail in
  // the moderation flow whose recipient is on the other side of the decision.
  const ownerNotified = await sendTakedownNotice(
    puzzle.owner.email,
    puzzle.title,
    category,
    puzzle.owner.locale,
  )
    .then(() => true)
    .catch((err) => {
      console.error(`[admin] takedown notice to the owner failed:`, err);
      return false;
    });

  // ownerNotified=false so the queue can tell the admin to contact the owner
  // manually — the takedown succeeded, but nobody was informed.
  return NextResponse.json({ ok: true, ownerNotified });
}
