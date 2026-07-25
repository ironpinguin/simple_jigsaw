import { prisma } from "@/lib/db";
import BansAdmin from "@/components/admin/BansAdmin";

export default async function AdminBansPage() {
  const bans = await prisma.bannedEmail.findMany({ orderBy: { createdAt: "desc" } });
  const initial = bans.map((b) => ({
    id: b.id,
    value: b.value,
    type: b.type,
    createdAt: b.createdAt.toISOString(),
  }));
  return <BansAdmin initial={initial} />;
}
