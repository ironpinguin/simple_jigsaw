import { NextResponse } from "next/server";
import { auth, getSessionUser } from "@/lib/auth";
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
    const sessionUser = (await auth())?.user;
    const viewer = sessionUser?.id
      ? { id: sessionUser.id, role: sessionUser.role ?? "USER" }
      : null;
    // 404, not 403 — a private puzzle must not confirm its own existence.
    if (!canViewPuzzle(puzzle, viewer)) {
      return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
    }
  }

  return NextResponse.json({ puzzle });
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
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  // 404 for a missing puzzle and for someone else's alike — visibility is the
  // owner's call, and the route must not confirm a foreign puzzle exists.
  if (!puzzle || puzzle.ownerId !== user.id) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }

  const updated = await prisma.puzzle.update({
    where: { id },
    data: { isPublic: parsed.data.isPublic },
    select: { id: true, isPublic: true },
  });

  return NextResponse.json({ puzzle: updated });
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
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) {
    return NextResponse.json({ error: t("puzzleNotFound") }, { status: 404 });
  }
  if (puzzle.ownerId !== user.id) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }

  await prisma.puzzle.delete({ where: { id } });
  // Best-effort image cleanup; ignore storage errors.
  await deleteObject(puzzle.imageKey).catch(() => {});

  return NextResponse.json({ ok: true });
}
