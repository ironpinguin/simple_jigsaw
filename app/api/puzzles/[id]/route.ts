import { NextResponse } from "next/server";
import { auth, getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) {
    return NextResponse.json({ error: "Puzzle nicht gefunden." }, { status: 404 });
  }

  if (!puzzle.isPublic) {
    const session = await auth();
    if (session?.user?.id !== puzzle.ownerId) {
      return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
    }
  }

  return NextResponse.json({ puzzle });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) {
    return NextResponse.json({ error: "Puzzle nicht gefunden." }, { status: 404 });
  }
  if (puzzle.ownerId !== user.id) {
    return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  }

  await prisma.puzzle.delete({ where: { id } });
  // Best-effort image cleanup; ignore storage errors.
  await deleteObject(puzzle.imageKey).catch(() => {});

  return NextResponse.json({ ok: true });
}
