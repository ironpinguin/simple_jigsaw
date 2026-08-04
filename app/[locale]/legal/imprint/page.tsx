import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import {
  legalOperator,
  legalInstance,
  isOperatorComplete,
  missingOperatorFields,
  warnIncompleteOperator,
} from "@/lib/legal";

// The operator details come from the environment, and in the Docker setup
// `next build` runs with a different environment than the container that later
// serves the page — prerendering would bake in the build-time values (usually
// none at all). See lib/legal.ts for why this stays even though the `[locale]`
// layout's `auth()` call already de-opts the segment.
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
  const instance = legalInstance();

  if (!isOperatorComplete(operator)) {
    const missing = missingOperatorFields(operator);
    warnIncompleteOperator(missing);
    return (
      <div className="legal">
        <h1>{t("imprintTitle")}</h1>
        <div className="card">
          <h2>{t("notConfiguredTitle")}</h2>
          <p>{t("notConfiguredText", { fields: missing.join(", ") })}</p>
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
        {/* Keyed by index: the lines are operator-supplied free text and a
            repeated one (a doubled c/o, a city equal to the region) would
            collide. The list is static and never reorders. */}
        {operator.addressLines.map((line, i) => (
          <span key={i}>{line}</span>
        ))}
      </address>

      <h2>{t("contactTitle")}</h2>
      <p>
        {t("emailLabel")}: <a href={`mailto:${operator.email}`}>{operator.email}</a>
      </p>
      {operator.phone && (
        <p>
          {t("phoneLabel")}: {operator.phone}
        </p>
      )}

      {instance.privateService && <p className="muted">{t("privateService")}</p>}
      <p>
        <Link href="/legal/privacy">{t("privacyLink")}</Link>
      </p>
    </div>
  );
}
