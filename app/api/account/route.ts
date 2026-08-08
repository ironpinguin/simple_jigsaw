import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { deleteAccount, StorageCleanupError } from "@/lib/account-deletion";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ password: z.string().min(1) });

// Self-service erasure (GDPR Art. 17): the logged-in user deletes their own
// account, its puzzles and every image behind them.
export async function DELETE(request: Request) {
  const t = await getErrorT();

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidRequest") }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, role: true, passwordHash: true },
  });
  if (!user) {
    return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
  }

  // Re-authenticate: the session cookie alone must not be enough to erase an
  // account. A password-less row cannot hold a session at all (lib/auth.ts
  // rejects it at login), so there is no branch for it — bcrypt.compare
  // against a null hash would throw.
  if (!user.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: t("wrongPassword") }, { status: 401 });
  }

  // Same guard as the admin path: an instance without an admin cannot be
  // administered back into one.
  if (user.role === "ADMIN" && (await prisma.user.count({ where: { role: "ADMIN" } })) <= 1) {
    return NextResponse.json({ error: t("lastAdminDelete") }, { status: 400 });
  }

  try {
    if (!(await deleteAccount(user.id))) {
      return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof StorageCleanupError) {
      console.error(`[account] erasure of ${session.id} stopped at ${err.key}:`, err.cause);
      // 502, and nothing deleted: reporting success here would tell the user
      // their image is gone while it is still being served.
      return NextResponse.json({ error: t("storageFailed") }, { status: 502 });
    }
    throw err;
  }

  // The client signs out on 200 — the JWT stays valid until it expires, and
  // getSessionUser would resolve it to a row that no longer exists.
  return NextResponse.json({ ok: true });
}
