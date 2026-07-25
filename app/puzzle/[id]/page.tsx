import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import PuzzleSolver from "@/components/PuzzleSolver";

export default async function PuzzlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const puzzle = await prisma.puzzle.findUnique({ where: { id } });
  if (!puzzle) notFound();

  if (!puzzle.isPublic) {
    const session = await auth();
    if (session?.user?.id !== puzzle.ownerId) notFound();
  }

  const data = {
    id: puzzle.id,
    imageKey: puzzle.imageKey,
    imageWidth: puzzle.imageWidth,
    imageHeight: puzzle.imageHeight,
    cols: puzzle.cols,
    rows: puzzle.rows,
    seed: puzzle.seed,
  };

  return <PuzzleSolver puzzle={data} title={puzzle.title} />;
}
