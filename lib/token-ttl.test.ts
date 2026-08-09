import { describe, expect, it } from "vitest";
import { expiredTokenFilter, isExpired, tokenExpiry, TOKEN_TTL_MS } from "./token-ttl";

/**
 * Evaluate a Prisma comparison filter the way the database would, reading the
 * operator out of the object rather than assuming it. Switching the filter to
 * `lte` therefore changes what this returns at the boundary instead of being
 * invisible to the agreement test below.
 */
function matches(filter: { expiresAt: Record<string, Date> }, expiresAt: Date): boolean {
  const [operator, cutoff] = Object.entries(filter.expiresAt)[0];
  switch (operator) {
    case "lt":
      return expiresAt.getTime() < cutoff.getTime();
    case "lte":
      return expiresAt.getTime() <= cutoff.getTime();
    default:
      throw new Error(`unhandled operator: ${operator}`);
  }
}

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

describe("expiredTokenFilter", () => {
  it("selects exactly the tokens isExpired rejects", () => {
    // The sweep and the redeem path have to draw the line in the same place.
    // A token expiring precisely at `now` is still valid, so deleting it would
    // remove a link a user is about to click.
    const filter = expiredTokenFilter(NOW);
    for (const offset of [-TOKEN_TTL_MS.INVITE, -1000, -1, 0, 1, 1000, TOKEN_TTL_MS.INVITE]) {
      const expiresAt = new Date(NOW + offset);
      expect({ offset, swept: matches(filter, expiresAt) }).toEqual({
        offset,
        swept: isExpired(expiresAt, NOW),
      });
    }
  });

  it("leaves a token expiring exactly at the cutoff", () => {
    // The test above uses `isExpired` as its own oracle, so making both sides
    // inclusive would keep it green while moving the boundary. Pin the
    // boundary itself: a token expiring precisely at `now` is still
    // redeemable, and the sweep must leave it there.
    expect(matches(expiredTokenFilter(NOW), new Date(NOW))).toBe(false);
    expect(isExpired(new Date(NOW), NOW)).toBe(false);
  });

  it("spares a token that was just created", () => {
    // The opportunistic purge in createToken runs against the same clock that
    // stamps the new row; a cutoff derived from anything but `now` would eat it.
    for (const type of ["EMAIL_VERIFY", "INVITE"] as const) {
      expect(matches(expiredTokenFilter(NOW), tokenExpiry(type, NOW))).toBe(false);
    }
  });
});
