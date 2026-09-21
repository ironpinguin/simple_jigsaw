import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: (await getErrorT())("noAccess") }, { status: 403 });
  }
  const { id } = await params;
  try {
    await prisma.bannedEmail.delete({ where: { id } });
  } catch (error) {
    // P2025 — no such row — is the outcome the admin asked for, reached by
    // somebody else first: another admin's click, or a tab left open. Reporting
    // that as a failure would put a row back on their screen that is not there.
    if ((error as { code?: unknown } | null)?.code === "P2025") {
      return NextResponse.json({ ok: true });
    }
    // Anything else must not read as success. This was `.catch(() => {})`
    // followed by `{ ok: true }`, so a database that refused the delete
    // answered exactly like one that performed it: the row left the admin's
    // table and stayed in the table that decides who may register (#56).
    console.error(`[admin] deleting ban ${id} failed:`, error);
    return NextResponse.json({ error: (await getErrorT())("serverError") }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
