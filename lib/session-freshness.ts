// Whether a JWT predates the account's last password change. Pure, so the
// boundary is testable without a database or a session — the callback in
// lib/auth.ts is then thin enough to read at a glance.

/**
 * How far past `passwordChangedAt` the cutoff reaches.
 *
 * The stamp is taken from the application clock *before* the row commits, and
 * Auth.js stamps `iat` when it encodes the cookie, a moment later again. So a
 * session read that started while the password write was still in flight sees
 * no stamp, passes, and can be re-issued with an `iat` past the stamp it never
 * saw — surviving the change permanently, which is the one outcome this whole
 * mechanism exists to prevent. Prisma has no portable way to ask either
 * provider for its commit-time clock, so the window is closed here instead:
 * the cutoff covers the stamp plus long enough for that write and re-issue.
 *
 * The cost is the same kind as the `<=` below — a login that completes within
 * the margin of the change is bounced once. Signing out, loading /login and
 * submitting a password takes longer than that, and a retry lands past it.
 */
export const SESSION_CUTOFF_MARGIN_MS = 1_000;

/**
 * `iatSeconds` is the JWT's `iat` claim (whole seconds); `changedAt` is
 * `User.passwordChangedAt`, null for an account whose password has never
 * changed.
 *
 * Auth.js re-stamps `iat` on every session read (it calls `setIssuedAt()`
 * with no argument each time the JWT is encoded), so `iat` means "last
 * re-issue", not "sign-in time". A cookie can therefore be re-issued in the
 * same wall-clock second as a password change and, without care, would carry
 * that second forward and never go stale. To close that, anything issued *in
 * or before* the second of the change is refused: a same-second re-login is
 * bounced once by design, and must sign in again.
 */
export function isSessionStale(
  iatSeconds: number | undefined,
  changedAt: Date | null,
): boolean {
  if (changedAt === null) return false;
  if (iatSeconds === undefined) return true;
  return (
    iatSeconds <=
    Math.floor((changedAt.getTime() + SESSION_CUTOFF_MARGIN_MS) / 1000)
  );
}
