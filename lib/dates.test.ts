import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
