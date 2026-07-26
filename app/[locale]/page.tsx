import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { auth } from "@/lib/auth";
import { isRegistrationEnabled } from "@/lib/registration";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const session = await auth();
  const canRegister = isRegistrationEnabled();

  return (
    <div>
      <section className="hero">
        <h1>{t("title")}</h1>
        <p>{t("intro")}</p>
        {session?.user ? (
          <Link href="/create" className="button">
            {t("ctaCreate")}
          </Link>
        ) : canRegister ? (
          <Link href="/register" className="button">
            {t("ctaStart")}
          </Link>
        ) : (
          <Link href="/login" className="button">
            {t("ctaLogin")}
          </Link>
        )}
      </section>

      <section className="card">
        <h2>{t("howTitle")}</h2>
        <ol className="muted">
          <li>{t("step1")}</li>
          <li>{t("step2")}</li>
          <li>{t("step3")}</li>
          <li>{t("step4")}</li>
        </ol>
      </section>
    </div>
  );
}
