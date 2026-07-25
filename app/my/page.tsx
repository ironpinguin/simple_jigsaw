import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import MyPuzzles from "@/components/MyPuzzles";

export default async function MyPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/login?callbackUrl=/my");
  }

  const puzzles = await prisma.puzzle.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, imageKey: true, pieceCount: true },
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Meine Puzzles</h1>
        <Link href="/create" className="button">
          Neues Puzzle
        </Link>
      </div>

      {puzzles.length === 0 ? (
        <p className="muted" style={{ marginTop: 24 }}>
          Du hast noch keine Puzzles. <Link href="/create">Erstelle dein erstes!</Link>
        </p>
      ) : (
        <MyPuzzles initial={puzzles} />
      )}
    </div>
  );
}
