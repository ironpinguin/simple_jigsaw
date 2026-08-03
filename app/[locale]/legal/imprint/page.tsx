import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { legalOperator, isOperatorComplete } from "@/lib/legal";

// The operator details come from the environment, and in the Docker setup
// `next build` runs with a different environment than the container that later
// serves the page — prerendering would bake in the build-time values (usually
// none at all).
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legal" });
  return { title: `Jigsaw — ${t("imprintTitle")}` };
}

export default async function ImprintPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("legal");
  const operator = legalOperator();

  if (!isOperatorComplete(operator)) {
    return (
      <div className="legal">
        <h1>{t("imprintTitle")}</h1>
        <div className="card">
          <h2>{t("notConfiguredTitle")}</h2>
          <p>{t("notConfiguredText")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="legal">
      <h1>{t("imprintTitle")}</h1>
      <p>{t("imprintIntro")}</p>

      <h2>{t("responsibleTitle")}</h2>
      <address>
        {operator.name}
        {operator.addressLines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </address>

      {(operator.email || operator.phone) && (
        <>
          <h2>{t("contactTitle")}</h2>
          <p>
            {operator.email && (
              <>
                {t("emailLabel")}: <a href={`mailto:${operator.email}`}>{operator.email}</a>
                <br />
              </>
            )}
            {operator.phone && `${t("phoneLabel")}: ${operator.phone}`}
          </p>
        </>
      )}

      <p className="muted">{t("privateService")}</p>
      <p>
        <Link href="/legal/privacy">{t("privacyLink")}</Link>
      </p>
    </div>
  );
}
