import { NextResponse } from "next/server";
import { getObject } from "@/lib/storage";

// Public image delivery. Puzzle images must be viewable by anyone with the
// (public) puzzle link, so this route intentionally requires no auth.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const objectKey = key.join("/");

  try {
    const { body, contentType } = await getObject(objectKey);
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Nicht gefunden." }, { status: 404 });
  }
}
