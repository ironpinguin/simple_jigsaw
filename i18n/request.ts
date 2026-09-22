import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { DISPLAY_TIME_ZONE } from "@/lib/dates";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return {
    locale,
    // Without this, next-intl formats every ICU date argument — `{date, date,
    // long}` — and every `format.dateTime` in the *runtime's* zone: server-
    // rendered in the container's, hydrated in the visitor's, two different
    // strings, the hydration bug #38 fixed in a path lib/dates.ts never sees.
    // It is also a live wrong-day bug without it: the legal pages pass
    // `new Date(TERMS_VERSION)`, which is UTC midnight, so a container west of
    // UTC renders the previous date (#54).
    //
    // The same constant both formatting paths use, so they cannot disagree.
    timeZone: DISPLAY_TIME_ZONE,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
