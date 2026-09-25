import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildAccountExport, releaseExportSlot, takeExportSlot } from "@/lib/account-export";
import { getErrorT } from "@/lib/i18n-server";

// Self-service access (GDPR Art. 15): the logged-in user downloads everything
// stored about them, as JSON. What goes in the payload — and what deliberately
// does not — is decided in lib/account-export.ts.
export const dynamic = "force-dynamic";

export async function GET() {
  const t = await getErrorT();

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  // Before the queries, not after: the point of the limit is the two reads it
  // prevents.
  if (!takeExportSlot(session.id)) {
    return NextResponse.json({ error: t("tooManyRequests") }, { status: 429 });
  }

  // A slot pays for the reads below. Whenever they do not happen — no row, or
  // a database that could not answer — it is handed back, or five blips would
  // cost the user their allowance and then blame them for asking too often.
  try {
    // Only the columns the export publishes. `passwordHash` is not merely
    // dropped later, it is never read.
    const user = await prisma.user.findUnique({
      where: { id: session.id },
      select: {
        id: true,
        email: true,
        name: true,
        displayName: true,
        role: true,
        locale: true,
        emailVerified: true,
        termsAcceptedAt: true,
        termsVersion: true,
        createdAt: true,
      },
    });
    if (!user) {
      // The session is a JWT and outlives the row it names.
      releaseExportSlot(session.id);
      return NextResponse.json({ error: t("accountNotFound") }, { status: 404 });
    }

    const puzzles = await prisma.puzzle.findMany({
      where: { ownerId: session.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        imageKey: true,
        imageWidth: true,
        imageHeight: true,
        pieceCount: true,
        cols: true,
        rows: true,
        seed: true,
        isPublic: true,
        createdAt: true,
        competition: { select: { pieceCount: true, startsAt: true, endsAt: true } },
      },
    });

    const leaderboardEntries = await prisma.leaderboardEntry.findMany({
      where: { userId: session.id },
      orderBy: { achievedAt: "desc" },
      select: {
        ms: true,
        moves: true,
        achievedAt: true,
        competition: { select: { puzzleId: true, puzzle: { select: { title: true } } } },
      },
    });

    const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    const payload = buildAccountExport({ user, puzzles, leaderboardEntries, baseUrl });

    // Dated filename so repeated downloads do not overwrite each other, and
    // no-store because this is the whole account in one response.
    const filename = `jigsaw-export-${payload.exportedAt.slice(0, 10)}.json`;

    return NextResponse.json(payload, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    releaseExportSlot(session.id);
    throw err;
  }
}
