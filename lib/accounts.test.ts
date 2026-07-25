import { describe, it, expect } from "vitest";
import { domainOf, isEmailBanned, normalizeBanValue, type BanEntry } from "./bans";
import { parseAdminEmails, isAdminEmail } from "./admin-emails";
import { tokenExpiry, isExpired, TOKEN_TTL_MS } from "./token-ttl";
import { isRegistrationEnabled } from "./registration";

describe("bans", () => {
  it("extracts the domain case-insensitively", () => {
    expect(domainOf("Foo@Example.COM")).toBe("example.com");
    expect(domainOf("no-at-sign")).toBeNull();
    expect(domainOf("trailing@")).toBeNull();
  });

  it("matches exact email bans", () => {
    const bans: BanEntry[] = [{ value: "evil@example.com", type: "EMAIL" }];
    expect(isEmailBanned("Evil@Example.com", bans)).toBe(true);
    expect(isEmailBanned("good@example.com", bans)).toBe(false);
  });

  it("matches whole-domain bans", () => {
    const bans: BanEntry[] = [{ value: "spam.com", type: "DOMAIN" }];
    expect(isEmailBanned("anyone@SPAM.com", bans)).toBe(true);
    expect(isEmailBanned("anyone@ham.com", bans)).toBe(false);
  });

  it("normalizes ban values (strips @ from domains)", () => {
    expect(normalizeBanValue("  @Spam.COM ", "DOMAIN")).toBe("spam.com");
    expect(normalizeBanValue("  Evil@X.com ", "EMAIL")).toBe("evil@x.com");
  });
});

describe("admin emails", () => {
  it("parses a comma list into a normalized set", () => {
    const set = parseAdminEmails(" A@x.com , b@Y.com ,, ");
    expect([...set].sort()).toEqual(["a@x.com", "b@y.com"]);
  });

  it("checks membership case-insensitively", () => {
    expect(isAdminEmail("Admin@X.com", "admin@x.com")).toBe(true);
    expect(isAdminEmail("nope@x.com", "admin@x.com")).toBe(false);
    expect(isAdminEmail("a@x.com", "")).toBe(false);
    expect(isAdminEmail("a@x.com", undefined)).toBe(false);
  });
});

describe("token ttl", () => {
  it("computes expiry from now", () => {
    const now = 1_000_000;
    expect(tokenExpiry("EMAIL_VERIFY", now).getTime()).toBe(now + TOKEN_TTL_MS.EMAIL_VERIFY);
    expect(tokenExpiry("INVITE", now).getTime()).toBe(now + TOKEN_TTL_MS.INVITE);
  });

  it("detects expiry", () => {
    const now = 1_000_000;
    expect(isExpired(new Date(now - 1), now)).toBe(true);
    expect(isExpired(new Date(now + 1), now)).toBe(false);
  });
});

describe("registration switch", () => {
  it("is enabled by default and unless explicitly false", () => {
    expect(isRegistrationEnabled(undefined)).toBe(true);
    expect(isRegistrationEnabled("true")).toBe(true);
    expect(isRegistrationEnabled("")).toBe(true);
    expect(isRegistrationEnabled("False")).toBe(false);
    expect(isRegistrationEnabled("false")).toBe(false);
  });
});
