import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { isRegistrationEnabled } from "@/lib/registration";
import RegisterForm from "@/components/RegisterForm";

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  if (!isRegistrationEnabled()) {
    const t = await getTranslations("auth");
    return (
      <div className="form card">
        <h1>{t("registrationDisabledTitle")}</h1>
        <p className="muted">{t("registrationDisabledText")}</p>
        <p className="muted">
          <Link href="/login">{t("toLogin")}</Link>
        </p>
      </div>
    );
  }

  return <RegisterForm />;
}
