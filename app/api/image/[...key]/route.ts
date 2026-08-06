import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getObject } from "@/lib/storage";
import { getErrorT } from "@/lib/i18n-server";
import { canViewPuzzle, imageCacheControl } from "@/lib/visibility";

// Image delivery. Public puzzle images stay viewable by anyone with the link
// (no auth), but a non-public image is only served to its owner or an admin —
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

  const isPublic = puzzles.some((p) => p.isPublic);
  let allowed = isPublic;
  if (!allowed && puzzles.length > 0) {
    const sessionUser = (await auth())?.user;
    const viewer = sessionUser?.id
      ? { id: sessionUser.id, role: sessionUser.role ?? "USER" }
      : null;
    allowed = puzzles.some((p) => canViewPuzzle(p, viewer));
  }
  if (!allowed) {
    return NextResponse.json({ error: (await getErrorT())("puzzleNotFound") }, { status: 404 });
  }

  try {
    const { body, contentType } = await getObject(objectKey);
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": imageCacheControl(isPublic),
      },
    });
  } catch {
    return NextResponse.json({ error: (await getErrorT())("puzzleNotFound") }, { status: 404 });
  }
}
