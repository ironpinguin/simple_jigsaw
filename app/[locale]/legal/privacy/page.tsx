import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { legalProcessors } from "@/lib/legal";

// Same reason as the Impressum: the named processors come from the environment,
// which is only known at run time.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "legal" });
  return { title: `Jigsaw — ${t("privacyTitle")}` };
}

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("legal");
  const processors = legalProcessors();

  return (
    <div className="legal">
      <h1>{t("privacyTitle")}</h1>
      <p className="muted">{t("privacyUpdated")}</p>

      <h2>{t("controllerTitle")}</h2>
      <p>{t("controllerText")}</p>
      <p>
        <Link href="/legal/imprint">{t("imprintLink")}</Link>
      </p>

      <h2>{t("dataTitle")}</h2>

      <h3>{t("accountTitle")}</h3>
      <p>{t("accountText")}</p>

      <h3>{t("tokensTitle")}</h3>
      <p>{t("tokensText")}</p>

      <h3>{t("bansTitle")}</h3>
      <p>{t("bansText")}</p>

      <h3>{t("puzzlesTitle")}</h3>
      <p>{t("puzzlesText")}</p>

      <h3>{t("imagesTitle")}</h3>
      <p>{t("imagesText")}</p>
      <p>{t("imagesPublicText")}</p>

      <h3>{t("localTitle")}</h3>
      <p>{t("localText")}</p>

      <h2>{t("cookiesTitle")}</h2>
      <p>{t("cookiesText")}</p>

      <h2>{t("logsTitle")}</h2>
      <p>{t("logsText")}</p>

      <h2>{t("recipientsTitle")}</h2>
      <p>
        {processors.mail
          ? t("recipientsMailExternal", { provider: processors.mail })
          : t("recipientsMailSelf")}
      </p>
      <p>
        {processors.storage
          ? t("recipientsStorageExternal", { provider: processors.storage })
          : t("recipientsStorageSelf")}
      </p>
      <p>{t("recipientsOther")}</p>

      <h2>{t("hostingTitle")}</h2>
      <p>{t("hostingText")}</p>

      <h2>{t("retentionTitle")}</h2>
      <p>{t("retentionText")}</p>

      <h2>{t("rightsTitle")}</h2>
      <p>{t("rightsText")}</p>
      <p>{t("rightsComplaint")}</p>

      <h2>{t("changesTitle")}</h2>
      <p>{t("changesText")}</p>
    </div>
  );
}
