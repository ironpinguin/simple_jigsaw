import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const admin = await requireAdmin();
  if (!admin) redirect(`/${locale}`);

  const openReports = await prisma.report.count({ where: { status: "OPEN" } });

  const t = await getTranslations("admin");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>{t("title")}</h1>
        <nav className="site-nav">
          <Link href="/admin/users">{t("usersTab")}</Link>
          <Link href="/admin/bans">{t("bansTab")}</Link>
          <Link href="/admin/reports">
            {t("reportsTab")}
            {openReports > 0 ? ` (${openReports})` : ""}
          </Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
