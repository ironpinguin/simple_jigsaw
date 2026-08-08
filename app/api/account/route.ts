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
  // rejects it at login), so it gets no error of its own — but the null check
  // stays in the condition, because bcrypt.compare against a null hash throws.
  if (!user.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: t("wrongPassword") }, { status: 401 });
  }

  // Same guard as the admin path. Recovering an admin-less instance takes
  // shell or env access (ADMIN_EMAILS, npm run make-admin), so the guard keeps
  // a self-service click from making that necessary.
  if (user.role === "ADMIN" && (await prisma.user.count({ where: { role: "ADMIN" } })) <= 1) {
    return NextResponse.json({ error: t("lastAdminDelete") }, { status: 400 });
  }

  try {
    if (!(await deleteAccount(user.id))) {
      return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
    }
  } catch (err) {
    if (err instanceof StorageCleanupError) {
      // Every row is still in place, but earlier objects may already be gone —
      // name them, or a puzzle left pointing at a missing object has nothing
      // tying it back to this attempt. A retry finishes the job.
      console.error(
        `[account] erasure of ${session.id} stopped at ${err.key} after deleting ${err.deleted.length} object(s):`,
        err,
      );
      return NextResponse.json({ error: t("storageFailed") }, { status: 502 });
    }
    // Every image is already gone by the time the transaction runs, so a
    // failure here is not merely "nothing happened".
    console.error(`[account] erasure of ${session.id} failed after its images were deleted:`, err);
    throw err;
  }

  // The client signs out on 200 — the JWT stays valid until it expires, and
  // getSessionUser would resolve it to a row that no longer exists.
  return NextResponse.json({ ok: true });
}
