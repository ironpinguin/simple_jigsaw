import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import {
  legalOperator,
  legalInstance,
  legalProcessors,
  isOperatorComplete,
  PRIVACY_UPDATED,
} from "@/lib/legal";
import { readNsfwConfig } from "@/lib/nsfw";

// The named processors and the hosting region come from the environment, and in
// the Docker setup `next build` sees a different one than the running container
// — see lib/legal.ts.
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
  const instance = legalInstance();
  const operator = legalOperator();
  const nsfw = readNsfwConfig(process.env);

  return (
    <div className="legal">
      <h1>{t("privacyTitle")}</h1>
      <p className="muted">{t("privacyUpdated", { date: new Date(PRIVACY_UPDATED) })}</p>

      <h2>{t("controllerTitle")}</h2>
      {/* Without operator details there is no controller to name, and the rights
          section below sends people to an address that does not exist — so say
          that instead of asserting a controller. */}
      <p>{isOperatorComplete(operator) ? t("controllerText") : t("controllerMissing")}</p>
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

      <h3>{t("leaderboardTitle")}</h3>
      <p>{t("leaderboardText")}</p>

      <h3>{t("imagesTitle")}</h3>
      <p>{t("imagesText")}</p>
      {/* Written for every upload regardless of mode — even `off` produces a
          neutral verdict — so this is not conditional the way the sentence
          below it is. */}
      <p>{t("imagesVerdictText")}</p>
      {/* Same wording covers local and external: both actually scan the
          image, so a data subject needs to know either way. `unavailable`
          keeps it too — nothing is scanned there, but the paragraph's
          operative promise to the reader is what happens to their upload, and
          a held-for-review puzzle is exactly what they get. Only `off` skips
          it, matching that mode's classifier never being asked anything
          (lib/nsfw/off.ts). */}
      {nsfw.mode !== "off" && <p>{t("imagesClassificationText")}</p>}
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
      {/* recipientsStorageSelf asserts images reach no third party at all —
          true only when there is also no classifier route. Gating on
          `processors.classifier` alone left a false statement open:
          NSFW_MODE=external with the legal variable unset would still print
          the exclusivity claim while every upload actually leaves. Adding the
          mode closes that.
          The two gates then err in opposite, deliberate directions. This one
          is conservative: a stale LEGAL_CLASSIFIER_PROCESSOR left over from a
          mode change drops a claim that is still true, omitting something
          rather than asserting something false. The classifier paragraph
          below is strict: it needs both, so it never names a processor that
          is not receiving anything. Note `unavailable` (lib/nsfw/config.ts)
          is not `external` here, and correctly so — a classifier that cannot
          run sends no images anywhere.
          The one combination that states nothing false but still discloses
          too little is mode=external with the variable unset: no processor is
          named. readNsfwConfig warns about exactly that, and
          docs/data-processors.md documents it. */}
      <p>
        {processors.storage
          ? t("recipientsStorageExternal", { provider: processors.storage })
          : processors.classifier || nsfw.mode === "external"
            ? t("recipientsStorageSelfClassified")
            : t("recipientsStorageSelf")}
      </p>
      {/* Unlike mail/storage there is no "self-hosted" half: off and local
          never send the image anywhere, so an unset processor means nothing
          to disclose rather than a claim to make. Requiring both conditions
          (not just a named processor) means a stray LEGAL_CLASSIFIER_PROCESSOR
          left over from a mode change never claims a transfer that mode=off
          or =local no longer makes. */}
      {processors.classifier && nsfw.mode === "external" && (
        <p>{t("recipientsClassifierExternal", { provider: processors.classifier })}</p>
      )}
      <p>{t("recipientsOther")}</p>

      <h2>{t("hostingTitle")}</h2>
      <p>
        {instance.hostingRegion
          ? t("hostingTextRegion", { region: instance.hostingRegion })
          : t("hostingTextUnknown")}
      </p>

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
