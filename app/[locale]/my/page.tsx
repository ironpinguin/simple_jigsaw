import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import MyPuzzles from "@/components/MyPuzzles";
import ExportAccount from "@/components/ExportAccount";
import DeleteAccount from "@/components/DeleteAccount";

// Per-request page (auth + DB); never prerender/query the DB at build time.
export const dynamic = "force-dynamic";

export default async function MyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await auth();
  if (!session?.user) {
    redirect(`/${locale}/login?callbackUrl=/my`);
  }

  const t = await getTranslations("my");
  const puzzles = await prisma.puzzle.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, imageKey: true, pieceCount: true, isPublic: true },
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{t("title")}</h1>
        <Link href="/create" className="button">
          {t("newPuzzle")}
        </Link>
      </div>

      {puzzles.length === 0 ? (
        <p className="muted" style={{ marginTop: 24 }}>
          {t("empty")} <Link href="/create">{t("createFirst")}</Link>
        </p>
      ) : (
        <MyPuzzles initial={puzzles} />
      )}

      <ExportAccount />
      <DeleteAccount />
    </div>
  );
}
