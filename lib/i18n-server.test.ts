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

// Real catalogs, keyed by the locale getErrorT passes. Omitting the locale
// models what next-intl actually does: it resolves through i18n/request.ts,
// which has no [locale] segment to read on a non-prefixed /api route and so
// yields the default. That is the silent-German failure this pins.
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ locale, namespace }: { locale?: string; namespace: string }) => {
    const catalogs: Record<string, () => Promise<{ default: unknown }>> = {
      de: () => import("@/messages/de.json"),
      en: () => import("@/messages/en.json"),
      it: () => import("@/messages/it.json"),
    };
    const load = catalogs[locale ?? "de"];
    if (!load) throw new Error(`unsupported locale ${locale}`);
    const messages = (await load()).default as Record<string, Record<string, string>>;
    return (key: string) => {
      const value = messages[namespace]?.[key];
      if (value === undefined) throw new Error(`missing translation key ${namespace}.${key}`);
      return value;
    };
  },
}));

// Not `it` — that is vitest's test function.
import deMessages from "@/messages/de.json";
import enMessages from "@/messages/en.json";
import itMessages from "@/messages/it.json";
import { getErrorT, resolveRequestLocale } from "./i18n-server";

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

// getErrorT is how the resolved locale reaches ~15 API routes, and it is the
// half of #35 that no route test can see: they all stub this module out. Assert
// on real catalog strings so dropping the explicit locale — which silently
// resolves to German for every non-prefixed route — fails here.
describe("getErrorT", () => {
  it("translates into the browser language when there is no cookie", async () => {
    request({ acceptLanguage: "en-US,en;q=0.9" });
    const t = await getErrorT();
    expect(t("notLoggedIn")).toBe(enMessages.errors.notLoggedIn);
    // Spelled out because it is the whole point: not the default catalog.
    expect(t("notLoggedIn")).not.toBe(deMessages.errors.notLoggedIn);
  });

  it("follows the cookie over the browser language", async () => {
    request({ cookie: "it", acceptLanguage: "de-DE,de;q=0.9" });
    const t = await getErrorT();
    expect(t("notLoggedIn")).toBe(itMessages.errors.notLoggedIn);
  });

  it("falls back to the default catalog when nothing identifies the caller", async () => {
    request({});
    const t = await getErrorT();
    expect(t("notLoggedIn")).toBe(deMessages.errors.notLoggedIn);
  });
});
