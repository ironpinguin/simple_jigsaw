import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/auth";

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

  const t = await getTranslations("admin");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>{t("title")}</h1>
        <nav className="site-nav">
          <Link href="/admin/users">{t("usersTab")}</Link>
          <Link href="/admin/bans">{t("bansTab")}</Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
