import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteObject } from "@/lib/storage";

const PatchSchema = z.object({ role: z.enum(["USER", "ADMIN"]) });

async function adminCount(): Promise<number> {
  return prisma.user.count({ where: { role: "ADMIN" } });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  }
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Ungültige Rolle." }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "Nutzer nicht gefunden." }, { status: 404 });
  }

  // Don't leave the system without an admin.
  if (target.role === "ADMIN" && parsed.data.role === "USER" && (await adminCount()) <= 1) {
    return NextResponse.json(
      { error: "Der letzte Admin kann nicht herabgestuft werden." },
      { status: 400 },
    );
  }

  await prisma.user.update({ where: { id }, data: { role: parsed.data.role } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  }
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    include: { puzzles: { select: { imageKey: true } } },
  });
  if (!target) {
    return NextResponse.json({ error: "Nutzer nicht gefunden." }, { status: 404 });
  }
  if (target.role === "ADMIN" && (await adminCount()) <= 1) {
    return NextResponse.json(
      { error: "Der letzte Admin kann nicht gelöscht werden." },
      { status: 400 },
    );
  }

  // Best-effort cleanup of the user's images (DB rows cascade automatically).
  await Promise.all(
    target.puzzles.map((p) => deleteObject(p.imageKey).catch(() => {})),
  );
  await prisma.user.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
