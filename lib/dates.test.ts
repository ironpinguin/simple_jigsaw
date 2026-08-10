import { describe, expect, it } from "vitest";
import { formatDateTimeUtc, formatDateUtc } from "./dates";

// The timestamp from the hydration mismatch in #38: 12:53:18 UTC, which the
// browser in the report rendered as 14:53 in CEST.
const ISO = "2026-08-08T12:53:18.000Z";
const LOCALES = ["de", "en", "it"];

/** What the same instant looks like in a timezone that is emphatically not UTC. */
function inZone(locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone,
  }).format(new Date(ISO));
}

describe("formatDateTimeUtc", () => {
  it("renders the UTC wall clock, whatever the runtime timezone is", () => {
    // The bug: the server formatted in the container's zone and the browser in
    // the visitor's, so the two strings differed by the offset. Pinning UTC is
    // what makes both sides agree, so the hour has to be the UTC one.
    for (const locale of LOCALES) {
      expect(formatDateTimeUtc(ISO, locale)).toContain("12:53:18");
      expect(formatDateTimeUtc(ISO, locale)).not.toBe(inZone(locale, "America/New_York"));
      expect(formatDateTimeUtc(ISO, locale)).not.toBe(inZone(locale, "Europe/Berlin"));
    }
  });

  it("labels the zone, because the time shown is not the reader's", () => {
    // An audit trail that silently shows a different clock than the admin's own
    // is worse than one that shows UTC and says so.
    for (const locale of LOCALES) {
      expect(formatDateTimeUtc(ISO, locale)).toContain("UTC");
    }
  });

  it("follows the locale it is given rather than the runtime default", () => {
    // The second half of #38: `toLocaleString()` with no argument renders an
    // /it page in whatever the server's ICU default happens to be.
    expect(formatDateTimeUtc(ISO, "de")).toBe("08.08.2026, 12:53:18 UTC");
    expect(formatDateTimeUtc(ISO, "en")).not.toBe(formatDateTimeUtc(ISO, "de"));
    expect(formatDateTimeUtc(ISO, "it")).not.toBe(formatDateTimeUtc(ISO, "en"));
  });

  it("is a pure function of its arguments", () => {
    // Server and client call this with the same row; anything time- or
    // environment-dependent in here would reintroduce the mismatch.
    expect(formatDateTimeUtc(ISO, "de")).toBe(formatDateTimeUtc(ISO, "de"));
  });
});

describe("formatDateUtc", () => {
  it("renders the UTC calendar day per locale", () => {
    expect(formatDateUtc(ISO, "de")).toBe("08.08.2026");
    expect(formatDateUtc(ISO, "en")).not.toBe(formatDateUtc(ISO, "de"));
  });

  it("keeps the UTC day for an instant that is already the next day locally", () => {
    // 23:30 UTC is the 9th in Berlin. Formatting in the runtime's zone is how
    // the date-only columns mismatched: the server said the 8th, the browser
    // the 9th.
    const lateEvening = "2026-08-08T23:30:00.000Z";
    expect(formatDateUtc(lateEvening, "de")).toBe("08.08.2026");
  });
});

describe("unparseable input", () => {
  it("returns the raw value instead of throwing", () => {
    // Every caller renders a string straight out of a DB row. A value that is
    // not a timestamp can only come from a hand-edited row, and showing it as
    // itself beats taking down the whole admin page with a RangeError.
    expect(formatDateTimeUtc("not a date", "de")).toBe("not a date");
    expect(formatDateUtc("", "en")).toBe("");
  });
});
