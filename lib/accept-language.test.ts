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

// Agreement with next-intl's own negotiation — the precondition the whole fix
// rests on — is asserted separately in accept-language.negotiation.test.ts,
// which runs both implementations against each other.
