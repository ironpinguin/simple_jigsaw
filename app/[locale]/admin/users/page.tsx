import { setRequestLocale } from "next-intl/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import UsersAdmin from "@/components/admin/UsersAdmin";
import { toAdminUserView } from "@/lib/admin-users";

// Per-request page (auth + DB); never prerender/query the DB at build time.
export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await getSessionUser();
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

  // Same projection as GET /api/admin/users, from the same helper (#52); only
  // the createdAt serialisation differs, because this one crosses into a
  // client component.
  const initial = users.map((u) => ({
    ...toAdminUserView(u),
    createdAt: u.createdAt.toISOString(),
  }));

  return <UsersAdmin initial={initial} currentUserId={me?.id ?? ""} />;
}
