/**
 * Date rendering for rows that are formatted on both sides of hydration.
 *
 * The admin lists are server-rendered per request (`force-dynamic`) and then
 * hydrated in the visitor's browser. `toLocaleString()` reads the *runtime's*
 * timezone and locale, so the two passes produced different strings whenever
 * the container's zone and the visitor's disagreed — React then threw a
 * hydration error and re-rendered the list client-side (#38).
 *
 * Both helpers are therefore deterministic for the strings the pages hand them
 * — `createdAt.toISOString()`, which always carries an offset: the timezone is
 * pinned to UTC and the locale comes from the URL, never from the environment.
 * A timestamp *without* an offset would still be parsed in the runtime's zone
 * by `new Date`, so don't pass one.
 *
 * The times shown are the instance's, not the reader's. The datetime format
 * says so itself; callers of `formatDateUtc` must label the column `(UTC)`,
 * because the date-only string carries no zone of its own.
 */

import { routing } from "@/i18n/routing";

/**
 * The one zone every rendered date is pinned to, here and in
 * `i18n/request.ts`, which hands it to next-intl so its own ICU date arguments
 * are pinned the same way (#54). One constant because two formatting paths
 * disagreeing about the zone is the bug, not the fix.
 */
export const DISPLAY_TIME_ZONE = "UTC";

/** Locale-aware date and time in UTC — `08.08.2026, 12:53:18 UTC` for `de`. */
export function formatDateTimeUtc(iso: string, locale: string): string {
  // `timeStyle: "long"` is what appends the "UTC" label. The label is the point
  // — an audit trail showing a clock that is not the reader's has to say whose
  // it is — so don't downgrade this to "medium".
  return format(iso, locale, { dateStyle: "medium", timeStyle: "long", timeZone: DISPLAY_TIME_ZONE });
}

/** Locale-aware calendar day in UTC — `08.08.2026` for `de`. */
export function formatDateUtc(iso: string, locale: string): string {
  return format(iso, locale, { dateStyle: "medium", timeZone: DISPLAY_TIME_ZONE });
}

function format(iso: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  // The signature says `string`, but `UsersAdmin.refresh` pushes unvalidated
  // API JSON straight into typed state — it checks the payload is an array,
  // not that each row's fields are strings — so a null or a missing field
  // genuinely reaches this. It has to be caught before `new Date`:
  // `new Date(null)` is the epoch rather than an Invalid Date, and a confident
  // "01.01.1970" in a moderation audit trail is worse than a blank.
  //
  // `BansAdmin.add` was the second such call site until #56 gave it a row
  // guard of its own. That is the shape to copy, not a reason to drop this:
  // the guard is the last line for every caller that has not grown one.
  if (typeof iso !== "string") {
    warnUnrenderable(iso);
    return "";
  }
  const date = new Date(iso);
  // A value that parses to nothing renders as itself: an admin seeing the raw
  // cell can report what is in the row, whereas the alternative is a RangeError
  // out of `Intl.format` taking the whole page down mid-render.
  if (Number.isNaN(date.getTime())) {
    warnUnrenderable(iso);
    return iso;
  }
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    // Only a structurally invalid tag lands here — "", "en_US", "  ". A
    // well-formed but unknown one ("xx") is resolved by the platform and never
    // throws, so this does not fire for it. The caller passing a malformed tag
    // is a bug in the caller; taking the reader's page down mid-render with a
    // RangeError is not the way to report it (#57).
    warnUnrenderableLocale(locale);
    return new Intl.DateTimeFormat(routing.defaultLocale, options).format(date);
  }
}

let warnedUnrenderableLocale = false;

/**
 * Say once per process that a caller handed over a locale the platform cannot
 * parse. Once, for the reason `warnUnrenderable` gives: this runs per row.
 */
function warnUnrenderableLocale(locale: unknown): void {
  if (warnedUnrenderableLocale) return;
  warnedUnrenderableLocale = true;
  console.warn(
    `[dates] falling back to ${routing.defaultLocale}: unusable locale tag ` +
      `${JSON.stringify(locale)}`,
  );
}

let warnedUnrenderable = false;

/**
 * Say once per process that a row carried something that is not a timestamp.
 * Once, because this runs per row inside a render and a bad list would
 * otherwise bury the console; at all, because the cell degrades to a blank and
 * silence is what turns a corrupt row into a permanent mystery.
 */
function warnUnrenderable(value: unknown): void {
  if (warnedUnrenderable) return;
  warnedUnrenderable = true;
  console.warn(`[dates] row carried an unrenderable timestamp: ${JSON.stringify(value)}`);
}
