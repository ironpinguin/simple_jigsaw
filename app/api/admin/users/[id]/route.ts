import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteAccount, StorageCleanupError } from "@/lib/account-deletion";
import { getErrorT } from "@/lib/i18n-server";

const PatchSchema = z.object({ role: z.enum(["USER", "ADMIN"]) });

async function adminCount(): Promise<number> {
  return prisma.user.count({ where: { role: "ADMIN" } });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const { id } = await params;
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidRole") }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: t("userNotFound") }, { status: 404 });
  }

  // Don't leave the system without an admin.
  if (target.role === "ADMIN" && parsed.data.role === "USER" && (await adminCount()) <= 1) {
    return NextResponse.json({ error: t("lastAdminDemote") }, { status: 400 });
  }

  await prisma.user.update({ where: { id }, data: { role: parsed.data.role } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const { id } = await params;

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
  if (!target) {
    return NextResponse.json({ error: t("userNotFound") }, { status: 404 });
  }
  if (target.role === "ADMIN" && (await adminCount()) <= 1) {
    return NextResponse.json({ error: t("lastAdminDelete") }, { status: 400 });
  }

  // Storage goes first and a storage failure aborts with every row intact, so
  // the admin sees the failure and retries — same policy as the puzzle
  // takedown; lib/account-deletion.ts owns it.
  try {
    if (!(await deleteAccount(id))) {
      return NextResponse.json({ error: t("userNotFound") }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof StorageCleanupError) {
      console.error(
        `[admin] deleting user ${id} stopped at ${err.key} after deleting ${err.deleted.length} object(s):`,
        err,
      );
      return NextResponse.json({ error: t("storageFailed") }, { status: 502 });
    }
    console.error(`[admin] deleting user ${id} failed after its images were deleted:`, err);
    throw err;
  }

  return NextResponse.json({ ok: true });
}
