import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import MyPuzzles from "@/components/MyPuzzles";
import ExportAccount from "@/components/ExportAccount";
import ChangePassword from "@/components/ChangePassword";
import DeleteAccount from "@/components/DeleteAccount";
import DisplayNameForm from "@/components/DisplayNameForm";
import SolvedPuzzles from "@/components/SolvedPuzzles";
import { groupBestTimes } from "@/lib/best-times";
import { toBoardBackground } from "@/lib/puzzle/background";

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
  const [rows, account, bestRows] = await Promise.all([
    prisma.puzzle.findMany({
      where: { ownerId: session.user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        imageKey: true,
        pieceCount: true,
        isPublic: true,
        boardBackground: true,
        competition: {
          select: {
            pieceCount: true,
            startsAt: true,
            endsAt: true,
            _count: { select: { entries: true } },
          },
        },
      },
    }),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { displayName: true } }),
    prisma.bestTime.findMany({
      where: { userId: session.user.id },
      orderBy: { achievedAt: "desc" },
      select: {
        pieceCount: true,
        ms: true,
        moves: true,
        puzzle: {
          select: { id: true, title: true, imageKey: true, ownerId: true, isPublic: true },
        },
      },
    }),
  ]);

  // The solver's best times (#127): the own puzzles show theirs in their card,
  // other people's get a section of their own — most recently improved first.
  const { byPuzzle: bestsByPuzzle, others: solved } = groupBestTimes(bestRows, session.user.id);
  // Dates as ISO strings: the client component receives plain JSON.
  const puzzles = rows.map(({ competition, ...p }) => ({
    ...p,
    boardBackground: toBoardBackground(p.boardBackground),
    bests: bestsByPuzzle.get(p.id) ?? [],
    competition: competition && {
      pieceCount: competition.pieceCount,
      startsAt: competition.startsAt?.toISOString() ?? null,
      endsAt: competition.endsAt?.toISOString() ?? null,
      entries: competition._count.entries,
    },
  }));

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

      <SolvedPuzzles puzzles={solved} />

      <DisplayNameForm initial={account?.displayName ?? null} />
      <ExportAccount />
      <ChangePassword />
      <DeleteAccount />
    </div>
  );
}
