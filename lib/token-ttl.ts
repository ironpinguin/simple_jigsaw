// Pure token lifetime helpers (no DB) so expiry logic is unit-testable.

export type TokenKind = "EMAIL_VERIFY" | "INVITE";

const HOUR = 60 * 60 * 1000;
export const TOKEN_TTL_MS: Record<TokenKind, number> = {
  EMAIL_VERIFY: 24 * HOUR,
  INVITE: 7 * 24 * HOUR,
};

/** Expiry timestamp for a freshly-created token of `type`, given `now` (ms). */
export function tokenExpiry(type: TokenKind, now: number): Date {
  return new Date(now + TOKEN_TTL_MS[type]);
}

export function isExpired(expiresAt: Date, now: number): boolean {
  return expiresAt.getTime() < now;
}

/**
 * Prisma `where` selecting the rows a retention sweep may delete — everything
 * `isExpired` would reject, and nothing else. It lives next to that predicate
 * because the two have to draw the line in the same place: `lt`, not `lte`, so
 * a token expiring precisely at `now` survives the sweep the same way it
 * survives being redeemed.
 *
 * `scripts/purge-expired.mjs` re-implements this predicate — it runs under
 * plain `node` with no TS loader, so it cannot import this module. Any change
 * to the boundary here has to be made there too.
 */
export function expiredTokenFilter(now: number): { expiresAt: { lt: Date } } {
  return { expiresAt: { lt: new Date(now) } };
}
