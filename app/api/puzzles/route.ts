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
 * What a *missing* verdict row means for a key, given whether a **public**
 * puzzle already references it.
 *
 * The case this rule exists to serve — an image uploaded before this feature —
 * is by definition already referenced by the puzzle it was uploaded for. A key
 * with no verdict and no such reference is a different animal: either the sweep
 * in lib/retention.ts removed the verdict as an orphan, or the write after
 * putObject failed (app/api/upload/route.ts). Nothing deletes the stored
 * object in either case, so calling that clean is a laundering route — upload
 * something explicit, never claim the key, wait out the grace period, then
 * create the puzzle against the remembered key and have it published with no
 * report and no admin ever involved. Held for review instead.
 *
 * `public` and not merely `referenced` is the load-bearing word, because the
 * claimant can supply a reference themselves. Claiming the key once gets a held
 * puzzle; a *second* POST with the same key would otherwise find that first
 * puzzle referencing it, pass the same-owner check (they do own it), still find
 * no verdict, and take the CLEAN carve-out — a public puzzle, with no report of
 * its own, and an image the reference-counted takedown in
 * app/api/admin/puzzles/[id]/route.ts then refuses to delete. A *public*
 * reference cannot be manufactured that way: a held puzzle is created with
 * `isPublic: isPublic && !pendingReview`, and PATCH to public answers 409 while
 * its AUTO_NSFW report is open, so only an admin who has looked at the image
 * can produce the reference that makes this carve-out apply.
 *
 * Accepted consequence, deliberately not "fixed" back: a pre-feature image
 * whose only puzzle is *private* now lands in review when its key is claimed
 * again. That is a false positive in the safe direction, no worse than the
 * honest user whose create form outlived the grace period (see
 * lib/retention.ts:VERDICT_GRACE_MS), and it costs an admin one glance.
 *
 * Except with classification off, where every upload is judged by nobody and
 * a held image would be the rule rather than the exception. `off` still writes
 * its own CLEAN/`model: "off"` row per upload, so a missing row there really
 * does mean an image from before this feature.
 */
function labelWithoutVerdict(referencedByAPublicPuzzle: boolean): VerdictLabel {
  if (referencedByAPublicPuzzle) return "CLEAN";
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

  // Who already references this key, and publicly or not. One read answers two
  // questions: whether someone *else* references it (the rejection right below)
  // and whether any *public* puzzle references it (what labelWithoutVerdict
  // needs). A key nobody has claimed yet yields an empty array.
  //
  // No `distinct` here on purpose. Prisma's `distinct` is applied client-side
  // on both providers — verified against Postgres 16 and SQLite with query
  // logging: the emitted SQL is a plain `SELECT ... WHERE "imageKey" = $1`,
  // with no `DISTINCT ON`, so it never spared the database or the wire a single
  // row. It would, however, have thrown away the answer to the second question:
  // `distinct: ["ownerId"]` keeps one arbitrary row per owner, so an owner with
  // both a private and a public puzzle on the key can come back private-only.
  //
  // Uploads aren't tracked in the DB until a puzzle claims them, so anyone
  // holding a leaked imageKey could otherwise attach it to their own (public)
  // puzzle and expose someone else's private image via /api/image. For a key
  // that was uploaded but never claimed there is no owner row to compare
  // against — its only protection is that keys are unguessable UUIDs.
  const references = await prisma.puzzle.findMany({
    where: { imageKey },
    select: { ownerId: true, isPublic: true },
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
    : labelWithoutVerdict(references.some((puzzle) => puzzle.isPublic));
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
