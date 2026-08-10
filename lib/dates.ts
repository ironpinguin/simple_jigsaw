/**
 * Date rendering for rows that are formatted on both sides of hydration.
 *
 * The admin lists are server-rendered per request (`force-dynamic`) and then
 * hydrated in the visitor's browser. `toLocaleString()` reads the *runtime's*
 * timezone and locale, so the two passes produced different strings whenever
 * the container's zone and the visitor's disagreed — React then threw a
 * hydration error and re-rendered the list client-side (#38).
 *
 * Both helpers below are therefore pure functions of `(iso, locale)`: the
 * timezone is pinned to UTC and the locale comes from the URL, never from the
 * environment. The times shown are the instance's, not the reader's, so the
 * datetime format carries its zone label and the date-only columns say `(UTC)`
 * in their header.
 */

/** Locale-aware date and time in UTC, e.g. `08.08.2026, 12:53:18 UTC`. */
export function formatDateTimeUtc(iso: string, locale: string): string {
  return format(iso, locale, { dateStyle: "medium", timeStyle: "long", timeZone: "UTC" });
}

/** Locale-aware calendar day in UTC, e.g. `08.08.2026`. */
export function formatDateUtc(iso: string, locale: string): string {
  return format(iso, locale, { dateStyle: "medium", timeZone: "UTC" });
}

function format(iso: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  // Callers render a string straight out of a DB row. A value that does not
  // parse can only come from a hand-edited row; showing it as itself beats
  // taking the admin page down with a RangeError.
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, options).format(date);
}
