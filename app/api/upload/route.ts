import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { getSessionUser } from "@/lib/auth";
import { putObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { prisma } from "@/lib/db";
import { getClassifier } from "@/lib/nsfw";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB upload cap
const MAX_EDGE = 2000; // downscale longest edge to keep solving smooth

export async function POST(request: Request) {
  const t = await getErrorT();
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: t("noFile") }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: t("unsupportedType") }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: t("tooLarge") }, { status: 400 });
  }

  const input = Buffer.from(await file.arrayBuffer());

  let output: Buffer;
  let width: number;
  let height: number;
  try {
    const result = await sharp(input)
      .rotate() // honour EXIF orientation
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    output = result.data;
    width = result.info.width;
    height = result.info.height;
  } catch {
    return NextResponse.json({ error: t("processFailed") }, { status: 400 });
  }

  const imageKey = `puzzles/${randomUUID()}.webp`;

  // Judge the re-encoded bytes, before they are stored: what gets served is
  // what gets judged. The guard in lib/nsfw turns any failure into UNKNOWN,
  // so this never throws and never blocks the upload.
  const verdict = await getClassifier().classify(output);

  await putObject(imageKey, output, "image/webp");

  try {
    await prisma.imageVerdict.create({
      data: {
        imageKey,
        label: verdict.label,
        score: verdict.score,
        model: verdict.model,
      },
    });
  } catch (error) {
    // The bytes are already stored, so failing here would lose an image that
    // exists — preferred over a 500 on an upload that otherwise worked. The
    // image is not waved through: /api/puzzles only reads a missing verdict as
    // clean for a key some puzzle already references, and this key has none
    // yet, so claiming it holds the puzzle for review instead (except with
    // classification off, where nothing is judged in the first place).
    console.error(`[nsfw] could not record the verdict for ${imageKey}:`, error);
  }

  // The verdict is deliberately absent from the response: a client that learns
  // the score learns the threshold.
  return NextResponse.json({ imageKey, width, height }, { status: 201 });
}
