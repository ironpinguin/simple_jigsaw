import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { sendTakedownNotice } from "@/lib/mail";
import type { ReportCategory } from "@/lib/reports";

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
    select: { imageKey: true, title: true, owner: { select: { email: true } } },
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

  const deleted = await prisma.puzzle.deleteMany({ where: { id } });
  if (deleted.count === 0) {
    // Raced with a concurrent delete of the same puzzle.
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  // One takedown resolves every open report of this puzzle; reporter contact
  // and IP hash are only needed while a report is open (anonymize on resolve).
  const openReport = await prisma.report.findFirst({
    where: { puzzleId: id, status: "OPEN" },
    select: { category: true },
  });
  await prisma.report.updateMany({
    where: { puzzleId: id, status: "OPEN" },
    data: {
      status: "TAKEDOWN",
      resolvedAt: new Date(),
      reporterEmail: null,
      reporterIpHash: null,
    },
  });

  await sendTakedownNotice(
    puzzle.owner.email,
    puzzle.title,
    (openReport?.category ?? "OTHER") as ReportCategory,
  ).catch((err) => {
    console.error(`[admin] takedown notice to the owner failed:`, err);
  });

  return NextResponse.json({ ok: true });
}
