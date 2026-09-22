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

import { hasLocale } from "next-intl";
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
  return new Intl.DateTimeFormat(usableLocale(locale), options).format(date);
}

/**
 * The tag to format with: the caller's, or the default when theirs is not one
 * this app ships (#57).
 *
 * Membership, not validity. `Intl.DateTimeFormat` accepts far more than three
 * locales, and what it does with the rest is the problem: a well-formed tag it
 * has no data for — `"xx"`, or a real one a given runtime lacks — resolves to
 * the *runtime's* own locale. Measured: one call renders "August 5, 2026",
 * "2026年8月5日", "5 agosto 2026" or "5. August 2026" depending only on the
 * host's LANG. Server and browser disagree, which is #38, and `NEXT_LOCALE` is
 * a cookie a visitor can set to anything. Checking the tag is *parseable* would
 * let all of that through; checking it is one of ours cannot.
 *
 * `undefined` is turned away by the same check, and is the case that made this
 * necessary: Intl accepts it and resolves to the runtime's locale with nothing
 * thrown and nothing logged. A caller reading a missing cookie or an empty
 * Accept-Language header produces exactly that.
 *
 * Blunt on purpose: `"en-GB"` falls back to German rather than to English,
 * because this is the last line rather than a negotiator. A caller that wants
 * `en` for `en-GB` should negotiate first — `matchAcceptLanguage` in
 * lib/accept-language.ts does — and hand over the result.
 *
 * Checked rather than caught, too. A `try` around the construction would also
 * swallow the other thing Intl validates, `options`, and then retry with the
 * same options and fail identically, uncaught, having logged a perfectly good
 * locale as the culprit. A mistyped `DISPLAY_TIME_ZONE` is our bug and belongs
 * in a stack trace on the first render.
 */
function usableLocale(locale: string): string {
  if (hasLocale(routing.locales, locale)) return locale;
  warnUnrenderableLocale(locale);
  return routing.defaultLocale;
}

let warnedUnrenderableLocale = false;

/**
 * Say once per process that a caller handed over a locale this app does not
 * ship. Once, for the reason `warnUnrenderable` gives: this runs per row.
 *
 * Not "invalid" — `"en-GB"` and `"xx"` are perfectly good tags — but rendering
 * them is what makes the server and the browser disagree, so the message names
 * what was actually wrong with it.
 */
function warnUnrenderableLocale(locale: unknown): void {
  if (warnedUnrenderableLocale) return;
  warnedUnrenderableLocale = true;
  console.warn(
    `[dates] falling back to ${routing.defaultLocale}: ` +
      `${JSON.stringify(locale)} is not a locale this app ships`,
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
