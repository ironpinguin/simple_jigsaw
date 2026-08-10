import { randomUUID } from "crypto";
import { extname } from "path";
import { NextResponse } from "next/server";
import { getSessionUser, getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { copyObject, deleteObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";
import { AUTO_REPORT_CATEGORIES } from "@/lib/reports";
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

  if (parsed.data.isPublic) {
    // Ownership must be settled before the hold lookup: a hold check keyed
    // only on puzzleId would answer 409-vs-404 for an id the caller does not
    // own, leaking both that the puzzle exists and that it is under
    // moderation — the same existence oracle the private branch below
    // deliberately avoids. This read is otherwise redundant with the
    // ownerId-scoped updateMany that follows; it exists only so a non-owner
    // gets identical output whether or not a hold exists.
    const owned = await prisma.puzzle.findUnique({
      where: { id },
      select: { ownerId: true },
    });
    if (!owned || owned.ownerId !== user.id) {
      return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
    }

    // A machine hold is not the owner's to lift: without this they can clear
    // it from "My puzzles" before an admin ever opens the queue. Scoped to
    // the machine categories on purpose — an open *user* report has never
    // blocked publishing, and this feature must not quietly change that.
    const held = await prisma.report.findFirst({
      where: { puzzleId: id, category: { in: [...AUTO_REPORT_CATEGORIES] }, status: "OPEN" },
      select: { id: true },
    });
    if (held) {
      return NextResponse.json({ error: t("awaitingReview") }, { status: 409 });
    }

    // The ownerId scope here is the actual authorisation, not the read
    // above: a race between the two must not turn into a write a non-owner
    // triggered.
    const updated = await prisma.puzzle.updateMany({
      where: { id, ownerId: user.id },
      data: { isPublic: true },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
    }
    return NextResponse.json({ puzzle: { id, isPublic: true } });
  }

  // Making a puzzle private rotates its imageKey: browsers may hold the old
  // public URL with the year-long immutable cache header older releases sent
  // (today's is capped at a day — see lib/visibility.ts), and a header change
  // cannot purge caches already populated. A fresh key makes every previously
  // shared URL stop resolving. 404 covers missing and foreign alike (no
  // existence oracle).
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    select: { ownerId: true, imageKey: true, isPublic: true },
  });
  if (!puzzle || puzzle.ownerId !== user.id) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }
  if (!puzzle.isPublic) {
    // Already private — nothing to change, nothing to rotate.
    return NextResponse.json({ puzzle: { id, isPublic: false, imageKey: puzzle.imageKey } });
  }

  const newKey = `puzzles/${randomUUID()}${extname(puzzle.imageKey) || ".webp"}`;
  // Copy first: the flip only proceeds once the object exists under the new
  // key, so there is never a DB row whose key has no object behind it.
  try {
    await copyObject(puzzle.imageKey, newKey);
  } catch (err) {
    console.error(`[puzzles] imageKey rotation copy for ${id} failed:`, err);
    return NextResponse.json({ error: t("storageFailed") }, { status: 502 });
  }

  // imageKey in the filter: if a concurrent request already rotated or the
  // puzzle vanished, this matches zero rows instead of double-rotating.
  const updated = await prisma.puzzle.updateMany({
    where: { id, ownerId: user.id, imageKey: puzzle.imageKey },
    data: { isPublic: false, imageKey: newKey },
  });
  if (updated.count === 0) {
    await deleteObject(newKey).catch((err) => {
      console.error(`[puzzles] cleanup of rotated object ${newKey} failed:`, err);
    });
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  // Old object cleanup is reference-counted (the owner may reuse a key across
  // puzzles) and best-effort: image delivery resolves keys via the puzzle
  // table, so an unreferenced key already answers 404 — a leftover object is
  // unreachable through the API, but a failure must stay observable.
  const stillReferenced = await prisma.puzzle.findFirst({
    where: { imageKey: puzzle.imageKey, id: { not: id } },
    select: { id: true },
  });
  if (!stillReferenced) {
    await deleteObject(puzzle.imageKey).catch((err) => {
      console.error(`[puzzles] cleanup of old object ${puzzle.imageKey} failed:`, err);
    });
  }

  // The new key must reach the client: thumbnails render from imageKey, and
  // the old key stops resolving the moment the rotation lands.
  return NextResponse.json({ puzzle: { id, isPublic: false, imageKey: newKey } });
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
