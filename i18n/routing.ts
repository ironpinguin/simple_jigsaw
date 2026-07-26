import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["de", "en", "it"],
  defaultLocale: "de",
  // Every URL carries an explicit locale prefix (/de, /en, /it).
  localePrefix: "always",
});

export type Locale = (typeof routing.locales)[number];
