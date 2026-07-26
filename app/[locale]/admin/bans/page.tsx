import { setRequestLocale } from "next-intl/server";
import { prisma } from "@/lib/db";
import BansAdmin from "@/components/admin/BansAdmin";

// Per-request page (auth + DB); never prerender/query the DB at build time.
export const dynamic = "force-dynamic";

export default async function AdminBansPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const bans = await prisma.bannedEmail.findMany({ orderBy: { createdAt: "desc" } });
  const initial = bans.map((b) => ({
    id: b.id,
    value: b.value,
    type: b.type,
    createdAt: b.createdAt.toISOString(),
  }));
  return <BansAdmin initial={initial} />;
}
