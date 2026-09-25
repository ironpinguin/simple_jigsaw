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
  const puzzle = await prisma.puzzle.findUnique({
    where: { id },
    include: { competition: { select: { pieceCount: true, startsAt: true, endsAt: true } } },
  });
  if (!puzzle) notFound();

  // A flagged upload is held private, so the owner is exactly who reaches
  // this branch — reuse that viewer instead of a second session lookup, and a
  // public puzzle (viewer left unresolved) never shows the note even with
  // ?review=1 on the URL.
  let showReviewNote = false;
  let viewer: Awaited<ReturnType<typeof getSessionViewer>> = null;
  if (!puzzle.isPublic) {
    viewer = await getSessionViewer();
    if (!canViewPuzzle(puzzle, viewer)) notFound();
    const { review } = await searchParams;
    showReviewNote = review === "1" && viewer?.id === puzzle.ownerId;
  }

  // Taking part needs to know who is solving; without a competition nothing on
  // the page depends on it, so the session is not even read.
  const { competition } = puzzle;
  if (competition && puzzle.isPublic) viewer = await getSessionViewer();

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
      <PuzzleSolver
        puzzle={data}
        title={puzzle.title}
        isPublic={puzzle.isPublic}
        competition={
          competition && {
            pieceCount: competition.pieceCount,
            startsAt: competition.startsAt?.toISOString() ?? null,
            endsAt: competition.endsAt?.toISOString() ?? null,
          }
        }
        viewer={{ signedIn: viewer !== null, isAdmin: viewer?.role === "ADMIN" }}
      />
    </>
  );
}
