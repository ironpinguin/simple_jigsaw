import { describe, expect, it } from "vitest";
import { matchAcceptLanguage } from "./accept-language";

const LOCALES = ["de", "en", "it"] as const;

function match(header: string | null | undefined) {
  return matchAcceptLanguage(header, LOCALES);
}

describe("matchAcceptLanguage", () => {
  describe("no usable header", () => {
    it("returns null for a missing header", () => {
      expect(match(null)).toBeNull();
      expect(match(undefined)).toBeNull();
    });

    it("returns null for an empty or whitespace header", () => {
      expect(match("")).toBeNull();
      expect(match("   ")).toBeNull();
    });

    it("returns null when no tag is one of the supported locales", () => {
      expect(match("fr-FR,fr;q=0.9,es;q=0.8")).toBeNull();
    });

    // A bare wildcard expresses no preference, so the caller's default should
    // win rather than whichever locale happens to be first in the list.
    it("ignores a wildcard", () => {
      expect(match("*")).toBeNull();
    });
  });

  describe("matching", () => {
    it("matches an exact tag", () => {
      expect(match("de")).toBe("de");
      expect(match("it")).toBe("it");
    });

    it("matches a region subtag to its base language", () => {
      expect(match("en-US")).toBe("en");
      expect(match("it-CH")).toBe("it");
    });

    it("is case-insensitive", () => {
      expect(match("EN-us")).toBe("en");
      expect(match("IT")).toBe("it");
    });

    it("tolerates surrounding whitespace", () => {
      // Same ranking as "en;q=0.9,de;q=0.5" — only the spacing differs.
      expect(match(" en ; q=0.9 , de ; q=0.5 ")).toBe("en");
    });

    it("skips unsupported tags and takes the first supported one", () => {
      expect(match("fr-FR,it;q=0.8")).toBe("it");
    });
  });

  describe("quality values", () => {
    it("prefers the highest q regardless of position", () => {
      expect(match("de;q=0.2,en;q=0.9")).toBe("en");
    });

    it("treats a missing q as 1", () => {
      expect(match("en,de;q=0.9")).toBe("en");
      // The tag without q outranks the earlier one that carries a lower q.
      expect(match("de;q=0.8,en")).toBe("en");
    });

    it("keeps header order when q values tie", () => {
      expect(match("it;q=0.9,en;q=0.9")).toBe("it");
      expect(match("en,it")).toBe("en");
    });

    it("drops a tag explicitly rejected with q=0", () => {
      expect(match("en;q=0,de;q=0.5")).toBe("de");
      expect(match("en;q=0")).toBeNull();
    });

    it("ignores a malformed q instead of dropping the tag", () => {
      expect(match("en;q=hello")).toBe("en");
    });
  });

  it("does not mistake a longer tag for a supported locale", () => {
    // Only a real subtag boundary counts, so a tag that merely starts with a
    // locale's letters is not a match.
    expect(match("deu")).toBeNull();
    expect(match("ita,de")).toBe("de");
  });
});

// The fix in lib/i18n-server.ts infers "no cookie ⇒ the browser language is the
// locale being browsed" from next-intl's middleware. That inference only holds
// while this matcher answers the same as next-intl's own negotiation
// (Negotiator + @formatjs/intl-localematcher). Both were run over this corpus
// and agree on every entry; if a next-intl upgrade changes its negotiation,
// these are the cases to re-check.
describe("agreement with next-intl's negotiation", () => {
  const REAL_BROWSER_HEADERS: ReadonlyArray<[string, string | null]> = [
    ["en-US,en;q=0.9", "en"],
    ["en-GB,en;q=0.9", "en"],
    ["de-DE,de;q=0.9", "de"],
    ["de-AT,de;q=0.9,en-US;q=0.8,en;q=0.7", "de"],
    ["de-CH", "de"],
    ["it-IT,it;q=0.9,en;q=0.8", "it"],
    ["it-CH", "it"],
    ["fr-FR,fr;q=0.9", null],
    ["zh-CN,zh;q=0.9,en;q=0.8", "en"],
    ["nl,de;q=0.7,en;q=0.3", "de"],
    ["en-Latn-US", "en"],
  ];

  it.each(REAL_BROWSER_HEADERS)("resolves %s the way next-intl does", (header, expected) => {
    expect(match(header)).toBe(expected);
  });

  // Known, deliberate divergences. None are reachable through a browser: for
  // each of these next-intl either negotiates the same locale anyway or writes
  // NEXT_LOCALE (it writes the cookie whenever its own matcher yields no
  // locale), which takes precedence and never reaches this matcher.
  it("differs from next-intl only on tags no browser emits", () => {
    // ISO 639-2 three-letter codes: intl-localematcher canonicalises "ita" to
    // "it", this matcher does not.
    expect(match("ita,de")).toBe("de");
    // Negotiator drops a tag with an unparseable q; this matcher keeps it at the
    // default weight of 1.
    expect(match("en;q=hello,de;q=0.9")).toBe("en");
  });
});
