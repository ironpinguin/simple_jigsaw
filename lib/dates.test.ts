import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import enMessages from "@/messages/en.json";
import { TERMS_VERSION } from "@/lib/legal";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DISPLAY_TIME_ZONE } from "./dates";
import { routing } from "@/i18n/routing";
import { formatDateTimeUtc, formatDateUtc } from "./dates";

// The timestamp from the hydration mismatch in #38: 12:53:18 UTC, which the
// browser in the report rendered as 14:53 in CEST.
const ISO = "2026-08-08T12:53:18.000Z";
// 23:30 UTC is already the 9th in Berlin and still the 8th in New York — the
// instant the date-only columns disagreed about.
const LATE_EVENING = "2026-08-08T23:30:00.000Z";
const LOCALES = ["de", "en", "it"];

/**
 * Run `fn` with the process reporting a different timezone. Node re-seats ICU's
 * default zone when `process.env.TZ` is reassigned, so this observes the exact
 * thing #38 was about: an implementation that leans on the ambient zone returns
 * two different strings here, whatever zone the machine running the suite is
 * in. Without it these tests only fail on a non-UTC developer laptop and pass
 * on a UTC CI runner — which is how the bug shipped in the first place.
 */
function underRuntimeZone<T>(timeZone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe("formatDateTimeUtc", () => {
  it("renders the same string whatever timezone the runtime is in", () => {
    // The regression test proper. Both calls must agree, and must agree on the
    // UTC wall clock rather than either machine's — that is what makes the
    // server pass and the hydration pass produce identical markup.
    for (const locale of LOCALES) {
      const tokyo = underRuntimeZone("Asia/Tokyo", () => formatDateTimeUtc(ISO, locale));
      const newYork = underRuntimeZone("America/New_York", () => formatDateTimeUtc(ISO, locale));
      expect({ locale, tokyo }).toEqual({ locale, tokyo: newYork });
      expect(tokyo).toContain("12:53:18");
    }
  });

  it("labels the zone, because the time shown is not the reader's", () => {
    // An audit trail that silently shows a different clock than the admin's own
    // is worse than one that shows UTC and says so. Asserted under a runtime
    // that is *not* UTC, so a missing pin cannot satisfy this with its own
    // ambient zone label.
    for (const locale of LOCALES) {
      expect(underRuntimeZone("Asia/Tokyo", () => formatDateTimeUtc(ISO, locale))).toContain("UTC");
    }
  });

  it("follows the locale it is given rather than the runtime default", () => {
    // The second half of #38: `toLocaleString()` with no argument renders an
    // /it page in whatever the server's ICU default happens to be.
    expect(formatDateTimeUtc(ISO, "de")).toBe("08.08.2026, 12:53:18 UTC");
    expect(formatDateTimeUtc(ISO, "it")).toBe("8 ago 2026, 12:53:18 UTC");
    expect(formatDateTimeUtc(ISO, "en")).not.toBe(formatDateTimeUtc(ISO, "de"));
  });
});

describe("formatDateUtc", () => {
  it("renders the UTC calendar day per locale", () => {
    expect(formatDateUtc(ISO, "de")).toBe("08.08.2026");
    expect(formatDateUtc(ISO, "it")).toBe("8 ago 2026");
    expect(formatDateUtc(ISO, "en")).not.toBe(formatDateUtc(ISO, "de"));
  });

  it("keeps the UTC day for an instant that falls on a different day locally", () => {
    // Formatting in the runtime's zone is how the date-only columns mismatched:
    // one side said the 8th, the other the 9th. Both runtimes must say the 8th.
    const tokyo = underRuntimeZone("Asia/Tokyo", () => formatDateUtc(LATE_EVENING, "de"));
    const newYork = underRuntimeZone("America/New_York", () => formatDateUtc(LATE_EVENING, "de"));
    expect([tokyo, newYork]).toEqual(["08.08.2026", "08.08.2026"]);
  });
});

describe("input that is not a timestamp", () => {
  beforeEach(() => {
    // Every case here trips the warning by design; silence it so a passing run
    // stays readable. The once-per-process semantics are asserted below.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an unparseable string as itself instead of throwing", () => {
    // `Intl.format` throws a RangeError on an Invalid Date, which would take
    // down the whole admin page rather than one cell.
    expect(formatDateTimeUtc("not a date", "de")).toBe("not a date");
    expect(formatDateUtc("", "en")).toBe("");
  });

  it("renders a blank rather than 1970 when the value is missing entirely", () => {
    // `new Date(null)` is the epoch, not an Invalid Date, so a null that slips
    // through unvalidated API JSON would otherwise render as a confident
    // 01.01.1970 in the audit trail — wrong, and wrong in a believable way.
    const missing = [null, undefined] as unknown as string[];
    for (const value of missing) {
      expect(formatDateUtc(value, "de")).toBe("");
      expect(formatDateTimeUtc(value, "de")).toBe("");
    }
  });

  it("says so on the console, so a corrupt row is not a silent blank", async () => {
    // The cell degrades quietly by design; the console is the only channel that
    // tells anyone the row is bad. The latch that keeps it to one message lives
    // at module scope, so this needs a module the tests above have not already
    // tripped — otherwise it would pass or fail on test ordering.
    vi.resetModules();
    const { formatDateUtc: freshFormatDateUtc } = await import("./dates");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    freshFormatDateUtc("not a date", "de");
    freshFormatDateUtc("also not a date", "de");

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("[dates]"),
    ]);
  });
});

describe("a locale tag the platform refuses", () => {
  // The file promises to degrade rather than throw and delivered half of it:
  // `iso` was guarded, `locale` — the second argument of the same expression —
  // was not. `new Intl.DateTimeFormat("")` throws a RangeError, and a RangeError
  // raised during a client render takes the page down, which is strictly worse
  // than the hydration warning #38 was about (#57).
  //
  // Unreachable from today's callers: every one passes `useLocale()`, which
  // i18n/routing.ts restricts to de/en/it. The next caller is the one that
  // derives a locale from the NEXT_LOCALE cookie or an Accept-Language header.

  it("falls back to the default locale instead of throwing", () => {
    // "en_US" with an underscore is the shape a hand-built tag actually takes.
    expect(() => formatDateUtc(ISO, "en_US")).not.toThrow();
    expect(formatDateUtc(ISO, "en_US")).toBe(formatDateUtc(ISO, routing.defaultLocale));
  });

  it("falls back for an empty tag too", () => {
    expect(formatDateUtc(ISO, "")).toBe(formatDateUtc(ISO, routing.defaultLocale));
  });

  it("keeps the zone pinned while falling back", () => {
    // The fallback must not quietly drop the UTC pin along with the locale —
    // that would trade a crash for the wrong day.
    expect(formatDateTimeUtc(ISO, "en_US")).toContain("UTC");
  });

  it("says so on the console rather than falling back in silence", async () => {
    // Same latch problem as the unrenderable-timestamp test above: the once
    // flag lives at module scope, so this needs a module the tests before it
    // have not already tripped, or it would pass or fail on test ordering.
    vi.resetModules();
    const { formatDateUtc: freshFormatDateUtc } = await import("./dates");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    freshFormatDateUtc(ISO, "en_US");
    freshFormatDateUtc(ISO, "");

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("[dates]"),
    ]);
    expect(String(warn.mock.calls[0][0])).toContain("en_US");
    warn.mockRestore();
  });

  it("leaves a well-formed but unknown tag to the platform's own fallback", async () => {
    // "xx" is well-formed, so the platform resolves it to its own default and
    // there is nothing to warn about. The fresh module matters as much as the
    // assertion: the once-per-process latch is already tripped by the tests
    // above, so on the shared module `not.toHaveBeenCalled` would hold no
    // matter what this call did.
    vi.resetModules();
    const { formatDateUtc: freshFormatDateUtc } = await import("./dates");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => freshFormatDateUtc(ISO, "xx")).not.toThrow();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back when there is no locale at all", async () => {
    // The one malformed locale that reproduces #38 rather than throwing:
    // `new Intl.DateTimeFormat(undefined, …)` resolves to the *runtime's*
    // locale, so the server pass and the hydration pass render different
    // strings with nothing raised and nothing logged. A caller reading a
    // missing NEXT_LOCALE cookie or an empty Accept-Language header hands over
    // `undefined`, not `""`.
    vi.resetModules();
    const { formatDateUtc: freshFormatDateUtc } = await import("./dates");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(freshFormatDateUtc(ISO, undefined as unknown as string)).toBe(
      formatDateUtc(ISO, routing.defaultLocale),
    );

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** The version stamp's calendar day as `{date, date, long}` renders it. */
function dayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone }).format(
    new Date(TERMS_VERSION),
  );
}

describe("the zone next-intl formats in", () => {
  // lib/dates.ts is not the only formatting path: a message using an ICU date
  // argument — `{date, date, long}` — is formatted by next-intl and never
  // touches this file. Without a `timeZone` in the request config that path
  // reads the *runtime's* zone, which is the #38 mechanism in a place
  // lib/dates.ts cannot reach (#54).

  it("renders a version stamp on its own day, not the container's", async () => {
    // TERMS_VERSION is a bare date, so `new Date` reads it as UTC midnight —
    // the instant most likely to land on the previous day west of UTC. This
    // suite runs in America/New_York, so an unpinned render says August 4.
    const t = createTranslator({
      locale: "en",
      messages: enMessages,
      timeZone: DISPLAY_TIME_ZONE,
    });

    // Derived, not spelled out: docs/terms-versioning.md says bumping
    // TERMS_VERSION needs nothing else changed, and it should not fail a
    // date-formatting suite that has no opinion about which version is current.
    // Still load-bearing — the control below derives the day before and they
    // must differ.
    expect(t("legal.termsUpdated", { date: new Date(TERMS_VERSION) })).toBe(
      `Last updated: ${dayIn(DISPLAY_TIME_ZONE)}`,
    );
  });

  it("would render the day before without the pin", () => {
    // The negative control: proof that the assertion above is load-bearing
    // rather than passing because the runner happens to be UTC.
    const unpinned = createTranslator({ locale: "en", messages: enMessages });

    expect(unpinned("legal.termsUpdated", { date: new Date(TERMS_VERSION) })).toBe(
      `Last updated: ${dayIn("America/New_York")}`,
    );
    // …and the two really are different days, or the assertion above would
    // hold whatever the zone did.
    expect(dayIn("America/New_York")).not.toBe(dayIn(DISPLAY_TIME_ZONE));
  });

  it("is the zone i18n/request.ts hands to next-intl", () => {
    // next-intl's server build refuses to load under the test resolver, so the
    // wiring is read from the source rather than executed. Weaker than running
    // it, and the only thing that fails if the line is deleted.
    const source = readFileSync(fileURLToPath(new URL("../i18n/request.ts", import.meta.url)), "utf8");

    expect(source).toContain("DISPLAY_TIME_ZONE");
    expect(source).toMatch(/timeZone:\s*DISPLAY_TIME_ZONE/);
  });
});
