import { createRequire } from "node:module";
import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";
import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";
import { matchAcceptLanguage } from "./accept-language";

// A differential test against next-intl's own Accept-Language negotiation.
//
// resolveRequestLocale infers "no NEXT_LOCALE cookie ⇒ the browser language is
// already the locale being browsed" from next-intl's middleware. That inference
// holds only while our matcher answers the same as next-intl's, so the two
// implementations agreeing is a correctness precondition, not a nicety —
// `negotiator` and `@formatjs/intl-localematcher` are devDependencies purely so
// this test can hold them to it.

const LOCALES = routing.locales;
const DEFAULT = routing.defaultLocale;

/**
 * next-intl's `getAcceptLanguageLocale`, transcribed from
 * `next-intl/dist/esm/development/middleware/resolveLocale.js` (4.14.5 —
 * re-read at that version, unchanged from 4.13.4).
 * Returns `undefined` when its matcher cannot decide — the case where the
 * middleware writes a cookie instead.
 */
function nextIntlNegotiate(header: string | null): string | undefined {
  const languages = new Negotiator({
    headers: { "accept-language": header || undefined },
  }).languages();
  try {
    // orderLocales(): longest-first, next-intl's workaround for formatjs#4469.
    const ordered = [...LOCALES].sort((a, b) => b.length - a.length);
    const matched = match(languages, ordered, DEFAULT);
    // mapToProvidedLocale(): back to our own casing.
    return LOCALES.find((locale) => locale.toLowerCase() === matched.toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * One visitor's journey with no cookie yet: the middleware redirects them to the
 * locale it negotiates, `syncCookie` decides whether to store it, and a later
 * API call resolves a locale for the error message and the mail.
 *
 * `page` is the language the visitor is reading; `effective` is the language
 * they are answered in. #35 is the two disagreeing.
 */
function visit(header: string) {
  const negotiated = nextIntlNegotiate(header);
  const page = negotiated ?? DEFAULT;
  // syncCookie writes the cookie only when its negotiation differs from the
  // locale being served — which includes every case where it decided nothing.
  const cookie = negotiated !== page ? page : null;
  const effective = cookie ?? matchAcceptLanguage(header, LOCALES) ?? DEFAULT;
  return { page, effective, cookie };
}

/** What browsers actually send, across the locales this app serves and some it does not. */
const REAL_BROWSER_HEADERS = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.9,de;q=0.8,it;q=0.7",
  "de-DE,de;q=0.9",
  "de-DE,de;q=0.9,en;q=0.8,it;q=0.7",
  "de-AT,de;q=0.9,en-US;q=0.8,en;q=0.7",
  "de-CH,de;q=0.9,en;q=0.8",
  "it-IT,it;q=0.9,en;q=0.8",
  "it-CH,it;q=0.9",
  "it,en;q=0.9,de;q=0.8",
  "fr-FR,fr;q=0.9",
  "fr-CH,fr;q=0.9,de;q=0.8",
  "es-ES,es;q=0.9,en;q=0.8",
  "pt-BR,pt;q=0.9,en;q=0.8",
  "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-Hant-TW,zh;q=0.9",
  "ja,en-US;q=0.9,en;q=0.8",
  "ru-RU,ru;q=0.9,en;q=0.8",
  "nl,de;q=0.7,en;q=0.3",
  "en-Latn-US",
  "de",
  "en",
  "it",
  "EN-us",
  "IT",
];

/** Headers a browser will not send, kept to pin exactly where the two disagree. */
const EXOTIC_HEADERS = [
  "*",
  "*;q=0.5",
  "it,*;q=0.5",
  "*,en;q=0.5",
  "",
  "   ",
  "x-default",
  "und",
  "en;q=0",
  "en;q=0,de;q=0.5",
  "deu",
  "ita,de",
  "eng",
  "en;q=hello",
  "en;q=hello,de;q=0.9",
  "en_US,it",
  "q=0.9,en",
  "de;q=5,en",
  "de;q=1.0,en;q=1.0",
  "en;level=1;q=0.4,de;q=0.3",
  "en,,de",
  ",de",
  "en,",
];

/**
 * Headers where the visitor is answered in a language other than the one they
 * are reading. Every entry is a tag no browser emits:
 *
 * - `ita` / `eng` / `und`: `@formatjs/intl-localematcher` canonicalises
 *   three-letter ISO 639-2 codes and `und`; our matcher only does subtag-prefix
 *   matching. (`deu` is absent because German is the default, so both sides land
 *   on `de` for it by coincidence rather than by agreement.)
 * - `en;q=hello`: `negotiator` drops a tag whose q will not parse, while we keep
 *   it at the RFC's default weight of 1.
 *
 * Asserted as an exact set, so a next-intl upgrade that introduces a new
 * divergence *or* removes one of these fails this test and sends you back to
 * the reasoning in lib/i18n-server.ts.
 */
const KNOWN_DIVERGENCES = ["und", "ita,de", "eng", "en;q=hello", "en;q=hello,de;q=0.9"];

describe("matchAcceptLanguage vs next-intl's negotiation", () => {
  it("compares against the very copies next-intl resolves", () => {
    // Declaring these as devDependencies risks npm handing next-intl a nested
    // different version, which would quietly turn this file into a test of
    // nothing. Resolve from next-intl's own directory and insist on one copy.
    const here = createRequire(import.meta.url);
    const fromNextIntl = createRequire(here.resolve("next-intl"));
    for (const pkg of ["negotiator", "@formatjs/intl-localematcher"]) {
      expect(fromNextIntl.resolve(pkg), `${pkg} is duplicated`).toBe(here.resolve(pkg));
    }
  });

  it.each(REAL_BROWSER_HEADERS)("negotiates %s identically", (header) => {
    expect(matchAcceptLanguage(header, LOCALES) ?? DEFAULT).toBe(
      nextIntlNegotiate(header) ?? DEFAULT,
    );
  });

  it("answers every real browser in the language of the page it is served", () => {
    const wrong = REAL_BROWSER_HEADERS.filter((h) => {
      const { page, effective } = visit(h);
      return page !== effective;
    });
    expect(wrong).toEqual([]);
  });

  it("diverges on exactly the tags no browser emits", () => {
    const wrong = [...REAL_BROWSER_HEADERS, ...EXOTIC_HEADERS].filter((h) => {
      const { page, effective } = visit(h);
      return page !== effective;
    });
    expect(wrong.sort()).toEqual([...KNOWN_DIVERGENCES].sort());
  });

  it("is never consulted when next-intl's matcher declines to decide", () => {
    // The reason most exotic headers are harmless: no decision means the
    // middleware stores a cookie, and the cookie outranks this matcher.
    const declined = EXOTIC_HEADERS.filter((h) => nextIntlNegotiate(h) === undefined);
    expect(declined.length).toBeGreaterThan(0);
    for (const header of declined) {
      expect(visit(header).cookie, `${header} should be pinned by a cookie`).toBe(DEFAULT);
    }
  });
});
