import { NextResponse } from "next/server";
import { auth, getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle } from "@/lib/visibility";

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
