import { NextResponse } from "next/server";
import { randomInt } from "crypto";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { computeGrid, PIECE_PRESETS } from "@/lib/puzzle/grid";
import { getErrorT } from "@/lib/i18n-server";
import { readNsfwConfig, requiresReview, toVerdictLabel, type VerdictLabel } from "@/lib/nsfw";
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

/**
 * What a *missing* verdict row means for a key, given whether any puzzle
 * already references it.
 *
 * The case this rule exists to serve — an image uploaded before this feature —
 * is by definition already referenced by the puzzle it was uploaded for. An
 * *unreferenced* key with no verdict is a different animal: either the sweep
 * in lib/retention.ts removed the verdict as an orphan, or the write after
 * putObject failed (app/api/upload/route.ts). Nothing deletes the stored
 * object in either case, so calling that clean is a laundering route — upload
 * something explicit, never claim the key, wait out the grace period, then
 * create the puzzle against the remembered key and have it published with no
 * report and no admin ever involved. Held for review instead.
 *
 * Except with classification off, where every upload is judged by nobody and
 * a held image would be the rule rather than the exception. `off` still writes
 * its own CLEAN/`model: "off"` row per upload, so a missing row there really
 * does mean an image from before this feature.
 */
function labelWithoutVerdict(referencedByAPuzzle: boolean): VerdictLabel {
  if (referencedByAPuzzle) return "CLEAN";
  return readNsfwConfig(process.env).mode === "off" ? "CLEAN" : "UNKNOWN";
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

  // Who already references this key. One read answers two questions: whether
  // someone *else* references it (the rejection right below) and whether
  // anyone references it at all (the missing-verdict rule further down needs
  // that). `distinct` keeps this to one row per owner instead of one per
  // puzzle, since an owner may legitimately reuse a key across their own
  // puzzles; a key nobody has claimed yet yields an empty array.
  //
  // Uploads aren't tracked in the DB until a puzzle claims them, so anyone
  // holding a leaked imageKey could otherwise attach it to their own (public)
  // puzzle and expose someone else's private image via /api/image. For a key
  // that was uploaded but never claimed there is no owner row to compare
  // against — its only protection is that keys are unguessable UUIDs.
  const references = await prisma.puzzle.findMany({
    where: { imageKey },
    select: { ownerId: true },
    distinct: ["ownerId"],
  });
  if (references.some((puzzle) => puzzle.ownerId !== user.id)) {
    return NextResponse.json({ error: t("invalidInput") }, { status: 400 });
  }

  const { cols, rows } = computeGrid(pieceCount, imageWidth / imageHeight);
  const seed = randomInt(0, 2 ** 31 - 1);

  // What the classifier decided at upload time. An unreadable label is not
  // clean: a column we cannot narrow is held for review rather than published.
  const stored = await prisma.imageVerdict.findUnique({
    where: { imageKey },
    select: { label: true, score: true, model: true },
  });
  const narrowedLabel = stored ? toVerdictLabel(stored.label) : null;
  const label = stored
    ? (narrowedLabel ?? "UNKNOWN")
    : labelWithoutVerdict(references.length > 0);
  const pendingReview = requiresReview(label);

  // One transaction: a report-write failure after a bare puzzle.create would
  // leave that puzzle row behind anyway — private, and invisible to every
  // admin, because the moderation queue is the only surface a machine
  // finding ever appears on. The client would then see a 500, retry, and
  // produce a *second* private puzzle instead of losing the first one to a
  // clean rollback. Mirrors the puzzle-plus-report shape in
  // app/api/admin/puzzles/[id]/route.ts and lib/account-deletion.ts.
  const puzzle = await prisma.$transaction(async (tx) => {
    const created = await tx.puzzle.create({
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
      // A label we can't narrow is not the classifier guard's own UNKNOWN (a
      // genuine failure, score meaninglessly 0 — an operationally ordinary
      // event). It means a stored value this code has never heard of, which
      // is version skew or corruption, not a normal miss. The raw stored
      // string goes in the message so an admin can tell the two apart
      // instead of seeing "UNKNOWN" for both. The third case — no row at all,
      // held by labelWithoutVerdict — is already distinguishable by the
      // `model unknown` the fallbacks below produce.
      const reportedLabel = stored && narrowedLabel === null ? stored.label : label;
      // Into the moderation queue, with no reporter: this is the server's own
      // finding, and inventing a reporter identity would put a person's name
      // on a judgement nobody made.
      await tx.report.create({
        data: {
          puzzleId: created.id,
          puzzleTitle: title,
          category: AUTO_REPORT_CATEGORIES[0],
          message: `Automatic classification: ${reportedLabel}, score ${stored?.score ?? 0}, model ${stored?.model ?? "unknown"}.`,
          reporterEmail: null,
          reporterIpHash: null,
          status: "OPEN",
        },
      });
    }

    return created;
  });

  return NextResponse.json({ id: puzzle.id, pendingReview }, { status: 201 });
}
