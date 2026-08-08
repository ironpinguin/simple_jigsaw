// Locale helpers for API route handlers and transactional email. API routes are
// not locale-prefixed, so the caller's language has to be recovered from the
// request itself.
//
// next-intl's middleware writes NEXT_LOCALE only when the requested locale
// differs from the one it negotiated from Accept-Language (see syncCookie in
// next-intl). So the two signals divide cleanly: a cookie means the visitor
// deliberately chose something other than their browser language and wins,
// while its absence means the browser language already matches the locale being
// browsed — which makes Accept-Language the right answer, not the default.

import { cookies, headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";
import { matchAcceptLanguage } from "./accept-language";

export async function resolveRequestLocale(): Promise<Locale> {
  const cookie = (await cookies()).get("NEXT_LOCALE")?.value;
  if (routing.locales.includes(cookie as Locale)) return cookie as Locale;

  const header = (await headers()).get("accept-language");
  return matchAcceptLanguage(header, routing.locales) ?? routing.defaultLocale;
}

/** Translator for the `errors` namespace in the caller's language. */
export async function getErrorT() {
  const locale = await resolveRequestLocale();
  return getTranslations({ locale, namespace: "errors" });
}
