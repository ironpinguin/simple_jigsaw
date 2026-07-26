import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { auth, signOut } from "@/lib/auth";
import { isRegistrationEnabled } from "@/lib/registration";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });
  return {
    title: `Jigsaw — ${t("title")}`,
    description: t("intro"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  // Enables static rendering for pages that don't opt into per-request data.
  setRequestLocale(locale);

  const session = await auth();
  const messages = await getMessages();
  const t = await getTranslations("nav");

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
        <header className="site-header">
          <Link href="/" className="brand">
            🧩 Jigsaw
          </Link>
          <nav className="site-nav">
            {session?.user ? (
              <>
                <Link href="/create">{t("create")}</Link>
                <Link href="/my">{t("myPuzzles")}</Link>
                {session.user.role === "ADMIN" && <Link href="/admin">{t("admin")}</Link>}
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: `/${locale}` });
                  }}
                >
                  <button className="link-button" type="submit">
                    {t("logout")}
                  </button>
                </form>
              </>
            ) : (
              <>
                <Link href="/login">{t("login")}</Link>
                {isRegistrationEnabled() && (
                  <Link href="/register" className="nav-cta">
                    {t("register")}
                  </Link>
                )}
              </>
            )}
            <LanguageSwitcher />
          </nav>
        </header>
        <main className="site-main">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
