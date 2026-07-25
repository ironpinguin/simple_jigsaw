import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import UsersAdmin from "@/components/admin/UsersAdmin";

export default async function AdminUsersPage() {
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

  const initial = users.map(({ passwordHash, emailVerified, createdAt, ...u }) => ({
    ...u,
    verified: emailVerified !== null,
    hasPassword: passwordHash !== null,
    createdAt: createdAt.toISOString(),
  }));

  return <UsersAdmin initial={initial} currentUserId={me?.id ?? ""} />;
}
