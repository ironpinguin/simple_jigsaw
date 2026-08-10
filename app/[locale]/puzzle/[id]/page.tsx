import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { prisma } from "@/lib/db";
import { getSessionViewer } from "@/lib/auth";
import { canViewPuzzle } from "@/lib/visibility";
import PuzzleSolver from "@/components/PuzzleSolver";

// Loads the puzzle from the DB per request; do not prerender at build time.
export const dynamic = "force-dynamic";

export default async function PuzzlePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) notFound();

  // A flagged upload is held private, so the owner is exactly who reaches
  // this branch — reuse that viewer instead of a second session lookup, and a
  // public puzzle (viewer left unresolved) never shows the note even with
  // ?review=1 on the URL.
  let showReviewNote = false;
  if (!puzzle.isPublic) {
    const viewer = await getSessionViewer();
    if (!canViewPuzzle(puzzle, viewer)) notFound();
    const { review } = await searchParams;
    showReviewNote = review === "1" && viewer?.id === puzzle.ownerId;
  }

  const t = await getTranslations("solve");
  const data = {
    id: puzzle.id,
    imageKey: puzzle.imageKey,
    imageWidth: puzzle.imageWidth,
    imageHeight: puzzle.imageHeight,
    pieceCount: puzzle.pieceCount,
    seed: puzzle.seed,
  };

  return (
    <>
      {showReviewNote && <p className="muted">{t("reviewPending")}</p>}
      <PuzzleSolver puzzle={data} title={puzzle.title} isPublic={puzzle.isPublic} />
    </>
  );
}
