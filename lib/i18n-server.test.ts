import { beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStore, headerStore } = vi.hoisted(() => ({
  cookieStore: new Map<string, string>(),
  headerStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) } : undefined,
  }),
  headers: async () => ({
    get: (name: string) => headerStore.get(name.toLowerCase()) ?? null,
  }),
}));

import { resolveRequestLocale } from "./i18n-server";

/** A request as the browser sends it: `cookie` omitted means none was set. */
function request({ cookie, acceptLanguage }: { cookie?: string; acceptLanguage?: string }) {
  cookieStore.clear();
  headerStore.clear();
  if (cookie !== undefined) cookieStore.set("NEXT_LOCALE", cookie);
  if (acceptLanguage !== undefined) headerStore.set("accept-language", acceptLanguage);
}

beforeEach(() => {
  cookieStore.clear();
  headerStore.clear();
});

describe("resolveRequestLocale", () => {
  // The regression behind #35: next-intl writes NEXT_LOCALE only when the URL
  // locale deviates from Accept-Language, so the visitors browsing in their own
  // browser language are exactly the ones arriving without a cookie.
  describe("without a cookie", () => {
    it("uses the browser language for an English visitor", async () => {
      request({ acceptLanguage: "en-US,en;q=0.9" });
      await expect(resolveRequestLocale()).resolves.toBe("en");
    });

    it("uses the browser language for an Italian visitor", async () => {
      request({ acceptLanguage: "it-IT,it;q=0.9,en;q=0.8" });
      await expect(resolveRequestLocale()).resolves.toBe("it");
    });

    it("falls back to the default locale when the header names no supported language", async () => {
      request({ acceptLanguage: "fr-FR,fr;q=0.9" });
      await expect(resolveRequestLocale()).resolves.toBe("de");
    });

    it("falls back to the default locale when there is no header at all", async () => {
      request({});
      await expect(resolveRequestLocale()).resolves.toBe("de");
    });
  });

  describe("with a cookie", () => {
    it("prefers the cookie over the browser language", async () => {
      // A German browser that switched to /en: next-intl stored the deviation,
      // and that deliberate choice must outrank Accept-Language.
      request({ cookie: "en", acceptLanguage: "de-DE,de;q=0.9" });
      await expect(resolveRequestLocale()).resolves.toBe("en");
    });

    it("ignores an unsupported cookie value and negotiates instead", async () => {
      request({ cookie: "fr", acceptLanguage: "it-IT,it;q=0.9" });
      await expect(resolveRequestLocale()).resolves.toBe("it");
    });

    it("ignores an empty cookie value", async () => {
      request({ cookie: "", acceptLanguage: "en-GB,en;q=0.9" });
      await expect(resolveRequestLocale()).resolves.toBe("en");
    });
  });
});
