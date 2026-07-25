import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Kein Zugriff." }, { status: 403 });
  }
  const { id } = await params;
  await prisma.bannedEmail.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
