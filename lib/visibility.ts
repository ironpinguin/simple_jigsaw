// Pure visibility rules for puzzles and their images, kept free of Prisma and
// Next.js so they stay unit-testable (see CLAUDE.md on lib/ purity).

import { ROLES, type Role } from "./roles";

export interface PuzzleVisibility {
  readonly isPublic: boolean;
  readonly ownerId: string;
}

export interface Viewer {
  readonly id: string;
  readonly role: Role;
}

/**
 * Narrow a user row (role is a plain string column) into a Viewer. An
 * unrecognized role falls back to USER — failing toward least privilege.
 */
export function toViewer(user: { id: string; role: string } | null | undefined): Viewer | null {
  if (!user) return null;
  const role: Role = (ROLES as readonly string[]).includes(user.role) ? (user.role as Role) : "USER";
  return { id: user.id, role };
}

/** A public puzzle is visible to everyone; a private one only to its owner or an admin. */
export function canViewPuzzle(puzzle: PuzzleVisibility, viewer: Viewer | null): boolean {
  if (puzzle.isPublic) return true;
  if (!viewer) return false;
  return viewer.id === puzzle.ownerId || viewer.role === "ADMIN";
}

export type ImageAccess =
  | { allowed: false }
  | { allowed: true; cacheControl: "public, max-age=86400" | "private, no-store" };

/**
 * Access + cache decision for an image, from every puzzle referencing its key
 * (imageKey is not unique in the schema). The cache header is only obtainable
 * together with a positive access decision so the two can never diverge:
 * - an unreferenced key (abandoned upload) is never served;
 * - any public reference makes the image public — cacheable, but capped at a
 *   day and without `immutable`, so making a puzzle private stops serving the
 *   image from caches (max-age binds shared caches like CDNs too) within a
 *   day (the URL never changes);
 * - a non-public image must not be cached at all, not even in the viewer's
 *   own browser, since access can be revoked by toggling visibility.
 *
 * A viewer only ever widens the result — the public arm ignores the viewer
 * entirely, so callers may probe with `null` first and resolve the session
 * only when that probe is denied.
 */
export function evaluateImageAccess(
  puzzles: readonly PuzzleVisibility[],
  viewer: Viewer | null,
): ImageAccess {
  if (puzzles.length === 0) return { allowed: false };
  if (puzzles.some((p) => p.isPublic)) {
    return { allowed: true, cacheControl: "public, max-age=86400" };
  }
  if (puzzles.some((p) => canViewPuzzle(p, viewer))) {
    return { allowed: true, cacheControl: "private, no-store" };
  }
  return { allowed: false };
}
