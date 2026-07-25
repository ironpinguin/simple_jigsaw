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
