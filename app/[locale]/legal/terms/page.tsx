import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { TERMS_VERSION } from "@/lib/legal";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legal" });
  return { title: `Jigsaw — ${t("termsTitle")}` };
}

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("legal");

  return (
    <div className="legal">
      <h1>{t("termsTitle")}</h1>
      <p className="muted">{t("termsUpdated", { date: new Date(TERMS_VERSION) })}</p>

      <h2>{t("termsScopeTitle")}</h2>
      <p>{t("termsScopeText")}</p>
      <p>
        <Link href="/legal/imprint">{t("imprintLink")}</Link>
      </p>

      <h2>{t("termsServiceTitle")}</h2>
      <p>{t("termsServiceText")}</p>

      <h2>{t("termsAccountTitle")}</h2>
      <p>{t("termsAccountText")}</p>

      <h2>{t("termsContentTitle")}</h2>
      <p>{t("termsContentIntro")}</p>
      <ul>
        <li>{t("termsContentPornographic")}</li>
        <li>{t("termsContentIllegal")}</li>
        <li>{t("termsContentRights")}</li>
      </ul>
      <p>{t("termsContentResponsibility")}</p>

      <h2>{t("termsModerationTitle")}</h2>
      <p>{t("termsModerationText")}</p>

      <h2>{t("termsAvailabilityTitle")}</h2>
      <p>{t("termsAvailabilityText")}</p>

      <h2>{t("termsLiabilityTitle")}</h2>
      <p>{t("termsLiabilityText")}</p>

      <h2>{t("termsChangesTitle")}</h2>
      <p>{t("termsChangesText")}</p>

      <p>
        <Link href="/legal/privacy">{t("privacyLink")}</Link>
      </p>
    </div>
  );
}
