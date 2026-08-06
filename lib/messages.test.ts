import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { routing } from "@/i18n/routing";

// Catalog parity, previously a manual check in the i18n-string skill. There is
// no fallback locale: a key present in de.json and missing from it.json throws at
// render time in Italian only. The legal pages made that worse — they are
// force-dynamic, so `next build` never renders them and a missing key survives
// lint, tests and build to reach the first visitor as a 500.

type Catalog = Record<string, unknown>;

function load(locale: string): Catalog {
  return JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"));
}

/** Every leaf key as a dotted path, in file order. */
function flatten(value: Catalog, prefix = ""): [string, string][] {
  return Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === "object"
      ? flatten(child as Catalog, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(child)] as [string, string]],
  );
}

/**
 * ICU argument names used by a message. Covers the bare `{provider}` form and
 * the typed `{date, date, long}` form; there is no plural or select syntax in
 * these catalogs, so the leading identifier is always the argument name.
 */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\s*(\w+)/g)].map((m) => m[1]).sort();
}

/** Rich-text tag names used by a message, e.g. `<terms>…</terms>`. */
function richTags(message: string): string[] {
  return [...message.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
}

/**
 * An ASCII apostrophe directly before an ICU syntax character ({ } < # |)
 * opens a quoted literal that runs to the end of the message. next-intl does
 * not error on it — the markup after the apostrophe renders as visible text,
 * so the mistake survives lint, tests and build. `''` is the escaped literal
 * apostrophe and is fine; write `dell''<privacy>`, not `dell'<privacy>`.
 */
function quotingHazards(message: string): string[] {
  return [...message.replaceAll("''", "").matchAll(/'[{}<#|]/g)].map((m) => m[0]);
}

const DEFAULT = routing.defaultLocale;
const OTHERS = routing.locales.filter((l) => l !== DEFAULT);

const entries = new Map(routing.locales.map((locale) => [locale, flatten(load(locale))]));
const reference = entries.get(DEFAULT)!;

describe(`message catalogs (${routing.locales.join(", ")})`, () => {
  it("covers every locale declared in the routing config", () => {
    // A new locale is a routing entry plus a full catalog; this fails on the
    // first half alone.
    expect(OTHERS.length).toBeGreaterThan(0);
    for (const locale of routing.locales) expect(entries.get(locale)!.length).toBeGreaterThan(0);
  });

  it.each(OTHERS)("%s has exactly the keys of the default locale", (locale) => {
    const keys = new Set(entries.get(locale)!.map(([key]) => key));
    const referenceKeys = reference.map(([key]) => key);
    expect(referenceKeys.filter((key) => !keys.has(key))).toEqual([]);
    expect([...keys].filter((key) => !referenceKeys.includes(key))).toEqual([]);
  });

  it.each(OTHERS)("%s keeps the key order of the default locale", (locale) => {
    // Not correctness, but it is what keeps a three-file diff readable.
    expect(entries.get(locale)!.map(([key]) => key)).toEqual(reference.map(([key]) => key));
  });

  it.each(OTHERS)("%s uses the same ICU placeholders as the default locale", (locale) => {
    // Translating {provider} to {fornitore} throws at render time, and on the
    // privacy page it would un-name a GDPR Art. 28 processor.
    const mismatched = entries
      .get(locale)!
      .map(([key, message], i) => ({
        key,
        expected: placeholders(reference[i][1]),
        actual: placeholders(message),
      }))
      .filter(({ expected, actual }) => expected.join(",") !== actual.join(","));
    expect(mismatched).toEqual([]);
  });

  it.each(OTHERS)("%s uses the same rich-text tags as the default locale", (locale) => {
    // Dropping <privacy> from a translation silently drops the privacy-policy
    // link from the consent checkbox — the string still renders.
    const mismatched = entries
      .get(locale)!
      .map(([key, message], i) => ({
        key,
        expected: richTags(reference[i][1]),
        actual: richTags(message),
      }))
      .filter(({ expected, actual }) => expected.join(",") !== actual.join(","));
    expect(mismatched).toEqual([]);
  });

  it.each(routing.locales)("%s never quotes ICU syntax with a bare apostrophe", (locale) => {
    const hazards = entries
      .get(locale)!
      .filter(([, message]) => quotingHazards(message).length > 0)
      .map(([key, message]) => ({ key, hazards: quotingHazards(message), message }));
    expect(hazards).toEqual([]);
  });

  it.each(routing.locales)("%s has no empty messages", (locale) => {
    expect(entries.get(locale)!.filter(([, message]) => message.trim() === "")).toEqual([]);
  });
});
