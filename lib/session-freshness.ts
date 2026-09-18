// Whether a JWT predates the account's last password change. Pure, so the
// boundary is testable without a database or a session — the callback in
// lib/auth.ts is then thin enough to read at a glance.

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
  return iatSeconds <= Math.floor(changedAt.getTime() / 1000);
}
