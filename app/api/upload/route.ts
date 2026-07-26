import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { getSessionUser } from "@/lib/auth";
import { putObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";

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
  await putObject(imageKey, output, "image/webp");

  return NextResponse.json({ imageKey, width, height }, { status: 201 });
}
