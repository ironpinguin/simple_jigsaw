import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { getErrorT } from "@/lib/i18n-server";
import { toAdminUserView } from "@/lib/admin-users";

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: (await getErrorT())("noAccess") }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      emailVerified: true,
      passwordHash: true,
      createdAt: true,
    },
  });

  // Never leak the hash; expose booleans instead. Shared with the server
  // component behind /admin/users so the two cannot drift (#52).
  return NextResponse.json({ users: users.map(toAdminUserView) });
}

const CreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["USER", "ADMIN"]).optional(),
});

// Direct create: admin sets an initial password; the account is active & verified.
export async function POST(request: Request) {
  const t = await getErrorT();
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: t("noAccess") }, { status: 403 });
  }

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const onPassword = parsed.error.issues.some((i) => i.path.includes("password"));
    return NextResponse.json(
      { error: onPassword ? t("passwordMin") : t("invalidInput") },
      { status: 400 },
    );
  }

  const email = normalizeEmail(parsed.data.email);
  if (await checkEmailBanned(email)) {
    return NextResponse.json({ error: t("emailBanned") }, { status: 403 });
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: t("emailTaken") }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: parsed.data.role ?? "USER",
      emailVerified: new Date(),
    },
    select: { id: true },
  });

  return NextResponse.json({ id: user.id }, { status: 201 });
}
