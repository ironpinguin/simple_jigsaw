// Pure visibility rules for puzzles and their images, kept free of Prisma and
// Next.js so they stay unit-testable (see CLAUDE.md on lib/ purity).

export interface PuzzleVisibility {
  isPublic: boolean;
  ownerId: string;
}

export interface Viewer {
  id: string;
  // "USER" | "ADMIN" (see lib/roles.ts)
  role: string;
}

/** A public puzzle is visible to everyone; a private one only to its owner or an admin. */
export function canViewPuzzle(puzzle: PuzzleVisibility, viewer: Viewer | null): boolean {
  if (puzzle.isPublic) return true;
  if (!viewer) return false;
  return viewer.id === puzzle.ownerId || viewer.role === "ADMIN";
}

/** Year-long immutable caching is only safe for public images; a private image must not land in shared caches. */
export function imageCacheControl(isPublic: boolean): string {
  return isPublic ? "public, max-age=31536000, immutable" : "private, no-store";
}
