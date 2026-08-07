import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { prisma } from "@/lib/db";
import { getSessionViewer } from "@/lib/auth";
import { canViewPuzzle } from "@/lib/visibility";
import PuzzleSolver from "@/components/PuzzleSolver";

// Loads the puzzle from the DB per request; do not prerender at build time.
export const dynamic = "force-dynamic";

export default async function PuzzlePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) notFound();

  if (!puzzle.isPublic) {
    if (!canViewPuzzle(puzzle, await getSessionViewer())) notFound();
  }

  const data = {
    id: puzzle.id,
    imageKey: puzzle.imageKey,
    imageWidth: puzzle.imageWidth,
    imageHeight: puzzle.imageHeight,
    pieceCount: puzzle.pieceCount,
    seed: puzzle.seed,
  };

  return <PuzzleSolver puzzle={data} title={puzzle.title} isPublic={puzzle.isPublic} />;
}
