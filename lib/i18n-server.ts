// Locale helpers for API route handlers and transactional email. API routes are
// not locale-prefixed, so the caller's language is read from the NEXT_LOCALE
// cookie that next-intl's middleware sets on every navigation.

import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { routing, type Locale } from "@/i18n/routing";

export async function localeFromCookie(): Promise<Locale> {
  const store = await cookies();
  const value = store.get("NEXT_LOCALE")?.value;
  return routing.locales.includes(value as Locale) ? (value as Locale) : routing.defaultLocale;
}

/** Translator for the `errors` namespace in the caller's language. */
export async function getErrorT() {
  const locale = await localeFromCookie();
  return getTranslations({ locale, namespace: "errors" });
}
