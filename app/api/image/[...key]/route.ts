import { NextResponse } from "next/server";
import { getSessionViewer } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { evaluateImageAccess } from "@/lib/visibility";

// Image delivery. Public puzzle images stay viewable by anyone with the link
// (no auth), but a non-public image is only served to an owner of a puzzle
// referencing it (legacy data may share a key across owners) or an admin —
// and the route answers 404 either way so it never confirms that a key exists.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const objectKey = key.join("/");

  // imageKey is not unique in the schema, so resolve every referencing puzzle
  // and grant access if any of them does. A key without a puzzle (an upload
  // whose creation was abandoned) is not served at all.
  const puzzles = await prisma.puzzle.findMany({
    where: { imageKey: objectKey },
    select: { isPublic: true, ownerId: true },
  });

  // First pass without a viewer so public images skip auth entirely; only a
  // referenced-but-not-public key is worth resolving the session for.
  let access = evaluateImageAccess(puzzles, null);
  if (!access.allowed && puzzles.length > 0) {
    access = evaluateImageAccess(puzzles, await getSessionViewer());
  }
  if (!access.allowed) {
    return NextResponse.json({ error: (await getErrorT())("puzzleNotFound") }, { status: 404 });
  }

  try {
    const { body, contentType } = await getObject(objectKey);
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": access.cacheControl,
      },
    });
  } catch (err) {
    // A referenced, authorized key should exist in storage — only a genuinely
    // missing object (fs ENOENT / s3 NoSuchKey) is a 404. Anything else is
    // infrastructure (credentials, connectivity) and must not be silently
    // reported as "not found".
    const missing =
      (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ||
      (err as { name?: string } | null)?.name === "NoSuchKey";
    if (missing) {
      // Correct answer for the client, but DB↔storage drift (lost volume,
      // cleanup race) that must stay visible to the operator.
      console.error(`[image] referenced object missing in storage: ${objectKey}`);
      return NextResponse.json({ error: (await getErrorT())("puzzleNotFound") }, { status: 404 });
    }
    console.error(`[image] storage read failed for key ${objectKey}:`, err);
    return NextResponse.json({ error: (await getErrorT())("serverError") }, { status: 500 });
  }
}
