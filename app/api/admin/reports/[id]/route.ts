import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getErrorT } from "@/lib/i18n-server";
import { resolveOpenReports } from "@/lib/reports-server";

const ActionSchema = z.object({ action: z.literal("dismiss") });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }
  const { id } = await params;

  // Only OPEN reports resolve, so dismissing twice (or a report a takedown
  // already resolved) is a 404 and anonymization happens exactly once.
  const resolved = await resolveOpenReports(prisma, { id }, "DISMISSED");
  if (resolved === 0) {
    return NextResponse.json({ error: t("reportNotFound") }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
