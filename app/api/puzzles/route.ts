import { NextResponse } from "next/server";
import { randomInt } from "crypto";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { computeGrid, PIECE_PRESETS } from "@/lib/puzzle/grid";
import { getErrorT } from "@/lib/i18n-server";
import { requiresReview, toVerdictLabel } from "@/lib/nsfw";
import { AUTO_REPORT_CATEGORIES } from "@/lib/reports";

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  imageKey: z.string().min(1),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  pieceCount: z.number().int().refine((n) => (PIECE_PRESETS as readonly number[]).includes(n)),
  isPublic: z.boolean().optional().default(true),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: (await getErrorT())("notLoggedIn") }, { status: 401 });
  }

  const puzzles = await prisma.puzzle.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      imageKey: true,
      pieceCount: true,
      isPublic: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ puzzles });
}

export async function POST(request: Request) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }

  const { title, imageKey, imageWidth, imageHeight, pieceCount, isPublic } = parsed.data;

  // Uploads aren't tracked in the DB until a puzzle claims them, so anyone
  // holding a leaked imageKey could otherwise attach it to their own (public)
  // puzzle and expose someone else's private image via /api/image. For a key
  // that was uploaded but never claimed there is no owner row to compare
  // against — its only protection is that keys are unguessable UUIDs.
  const foreign = await prisma.puzzle.findFirst({
    where: { imageKey, ownerId: { not: user.id } },
    select: { id: true },
  });
  if (foreign) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }

  const { cols, rows } = computeGrid(pieceCount, imageWidth / imageHeight);
  const seed = randomInt(0, 2 ** 31 - 1);

  // What the classifier decided at upload time. A missing row means the image
  // predates this feature or was uploaded with NSFW_MODE=off, both of which
  // are clean. An unreadable label is not: a column we cannot narrow is held
  // for review rather than published.
  const stored = await prisma.imageVerdict.findUnique({
    where: { imageKey },
    select: { label: true, score: true, model: true },
  });
  const label = stored ? (toVerdictLabel(stored.label) ?? "UNKNOWN") : "CLEAN";
  const pendingReview = requiresReview(label);

  const puzzle = await prisma.puzzle.create({
    data: {
      title,
      imageKey,
      imageWidth,
      imageHeight,
      pieceCount,
      cols,
      rows,
      seed,
      isPublic: isPublic && !pendingReview,
      ownerId: user.id,
    },
    select: { id: true },
  });

  if (pendingReview) {
    // Into the moderation queue, with no reporter: this is the server's own
    // finding, and inventing a reporter identity would put a person's name on
    // a judgement nobody made.
    await prisma.report.create({
      data: {
        puzzleId: puzzle.id,
        puzzleTitle: title,
        category: AUTO_REPORT_CATEGORIES[0],
        message: `Automatic classification: ${label}, score ${stored?.score ?? 0}, model ${stored?.model ?? "unknown"}.`,
        reporterEmail: null,
        reporterIpHash: null,
        status: "OPEN",
      },
    });
  }

  return NextResponse.json({ id: puzzle.id, pendingReview }, { status: 201 });
}
