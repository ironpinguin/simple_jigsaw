// Whether a JWT predates the account's last password change. Pure, so the
// boundary is testable without a database or a session — the callback in
// lib/auth.ts is then thin enough to read at a glance.

/**
 * `iatSeconds` is the JWT's `iat` claim (whole seconds); `changedAt` is
 * `User.passwordChangedAt`, null for an account whose password has never
 * changed.
 *
 * The comparison is second-to-second, so a token issued in the same second as
 * the change survives. See the test for why that direction was chosen.
 */
export function isSessionStale(
  iatSeconds: number | undefined,
  changedAt: Date | null,
): boolean {
  if (changedAt === null) return false;
  if (iatSeconds === undefined) return true;
  return iatSeconds < Math.floor(changedAt.getTime() / 1000);
}
