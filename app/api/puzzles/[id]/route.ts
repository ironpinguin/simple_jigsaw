import { NextResponse } from "next/server";
import { getSessionUser, getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { z } from "zod";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  if (!puzzle.isPublic) {
    // 404, not 403 — a private puzzle must not confirm its own existence.
    if (!canViewPuzzle(puzzle, await getSessionViewer())) {
      return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
    }
  }

  // The response omits ownerId: whoever may view a puzzle still must not
  // learn who owns it.
  return NextResponse.json({
    puzzle: {
      id: puzzle.id,
      title: puzzle.title,
      imageKey: puzzle.imageKey,
      imageWidth: puzzle.imageWidth,
      imageHeight: puzzle.imageHeight,
      pieceCount: puzzle.pieceCount,
      cols: puzzle.cols,
      rows: puzzle.rows,
      seed: puzzle.seed,
      isPublic: puzzle.isPublic,
      createdAt: puzzle.createdAt,
    },
  });
}

const UpdateSchema = z.object({ isPublic: z.boolean() });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = UpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }

  const { id } = await params;
  // updateMany scoped to ownerId makes lookup, ownership check and write one
  // atomic statement — a concurrently deleted puzzle just yields count 0
  // instead of a P2025 500. Zero rows covers a missing puzzle and someone
  // else's alike, answered 404 — visibility is the owner's call, and the
  // route must not confirm a foreign puzzle exists (same policy as DELETE).
  const updated = await prisma.puzzle.updateMany({
    where: { id, ownerId: user.id },
    data: { isPublic: parsed.data.isPublic },
  });
  if (updated.count === 0) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  return NextResponse.json({ puzzle: { id, isPublic: parsed.data.isPublic } });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { ownerId: true, imageKey: true },
  });
  // 404 for a missing puzzle and for someone else's alike — a 403 would
  // confirm a foreign puzzle exists (same policy as PATCH).
  if (!puzzle || puzzle.ownerId !== user.id) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  // Another puzzle may still reference the same imageKey. POST only permits
  // same-owner reuse, but older data may share keys across owners, so this
  // check is deliberately not owner-scoped: only remove the storage object
  // when nothing else references it at delete time (best-effort — a claim of
  // the same key concurrent with this request can still lose its object).
  // Checked before the row delete so a failed reference query cannot 500 a
  // delete that already happened.
  const stillReferenced = await prisma.puzzle.findFirst({
    where: { imageKey: puzzle.imageKey, id: { not: id } },
    select: { id: true },
  });

  const deleted = await prisma.puzzle.deleteMany({ where: { id, ownerId: user.id } });
  if (deleted.count === 0) {
    // Raced with a concurrent delete of the same puzzle.
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  if (!stillReferenced) {
    // Best-effort cleanup: the puzzle row is gone either way, but a failure
    // must stay observable or systematic orphaning would be invisible.
    await deleteObject(puzzle.imageKey).catch((err) => {
      console.error(`[puzzles] cleanup of storage object ${puzzle.imageKey} failed:`, err);
    });
  }

  return NextResponse.json({ ok: true });
}
