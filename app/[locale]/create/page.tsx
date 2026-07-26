import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { auth } from "@/lib/auth";
import CreateForm from "@/components/CreateForm";

export default async function CreatePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await auth();
  if (!session?.user) {
    redirect(`/${locale}/login?callbackUrl=/create`);
  }

  const t = await getTranslations("create");

  return (
    <div>
      <h1>{t("title")}</h1>
      <CreateForm />
    </div>
  );
}
