// Locale helpers for API route handlers and transactional email. API routes are
// not locale-prefixed, so the caller's language has to be recovered from the
// request itself.
//
// On a document navigation next-intl's middleware writes NEXT_LOCALE when the
// locale being browsed differs from the one it negotiates from Accept-Language
// (syncCookie, next-intl 4.13.4 — an unexported internal, so re-check it on
// upgrade). A cookie is therefore the stronger signal and wins. Its absence
// usually means the browser language already matches the locale being browsed,
// which makes Accept-Language a better answer than the default — though a
// cleared or blocked cookie looks the same, so this is a good guess rather than
// a proof.
//
// The absence case is only as good as the agreement between matchAcceptLanguage
// and next-intl's own negotiator; see the corpus in accept-language.test.ts.

import { cookies, headers } from "next/headers";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { matchAcceptLanguage } from "./accept-language";

export async function resolveRequestLocale(): Promise<Locale> {
  const cookie = (await cookies()).get("NEXT_LOCALE")?.value;
  if (hasLocale(routing.locales, cookie)) return cookie;

  const header = (await headers()).get("accept-language");
  return matchAcceptLanguage(header, routing.locales) ?? routing.defaultLocale;
}

/**
 * Translator for the `errors` namespace in the caller's language.
 *
 * Request-scoped: route handlers only. The explicit locale is load-bearing —
 * API routes sit outside `app/[locale]`, so next-intl would otherwise resolve
 * `requestLocale` to undefined and fall back to the default for everyone.
 */
export async function getErrorT() {
  const locale = await resolveRequestLocale();
  return getTranslations({ locale, namespace: "errors" });
}
