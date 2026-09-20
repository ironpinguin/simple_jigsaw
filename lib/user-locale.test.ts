import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";

// `User.locale` carries no database default on purpose, and that absence is
// load-bearing rather than an oversight: null is how a row says nobody has
// established this person's language yet. Give the column a "de" default and
// that state stops existing — an account that was never asked becomes
// indistinguishable from one whose owner chose German, and lib/auth.ts can no
// longer fill in the first without risking overwriting the second. Every row
// predating the column, and every account an admin creates outright, is in
// exactly that undetermined state.
describe("User.locale", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const line = /^\s*locale\s+(\S+)(.*)$/m.exec(schema);

  it("is declared on the User model", () => {
    expect(line, "no `locale` column found in the schema").not.toBeNull();
  });

  it("is optional, so an undetermined language is representable", () => {
    expect(line![1]).toBe("String?");
  });

  it("carries no default that would mask the undetermined state", () => {
    expect(line![2]).not.toContain("@default");
  });

  it("falls back to the default locale, which is what an unset row receives", () => {
    // The fallback lives in resolveLocale (lib/mail.ts) and is asserted against
    // real catalogs in mail.test.ts. Pinned here too because it is the reason
    // dropping the database default costs existing accounts nothing.
    expect(routing.defaultLocale).toBe("de");
  });
});
