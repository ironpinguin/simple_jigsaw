import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { routing } from "@/i18n/routing";

// Pins the Next file convention that carries locale routing (#85).
//
// `lib/accept-language.negotiation.test.ts` covers what next-intl *decides*;
// nothing covered how its handler is wired in, which is precisely what the
// middleware → proxy migration moved. Next resolves the convention by filename
// and export name, neither of which the type checker sees: a file renamed back,
// a `proxy` export renamed away, or a matcher that starts catching `/api` would
// all be green everywhere else.

// next-intl's handler reaches for `next/server`, which only resolves inside a
// Next build — so it is stubbed here. What is under test is the wiring, not the
// negotiation behind it.
const handler = vi.hoisted(() => vi.fn());
const createMiddleware = vi.hoisted(() => vi.fn(() => handler));
vi.mock("next-intl/middleware", () => ({ default: createMiddleware }));

const root = new URL("../", import.meta.url);

/** Basenames at one convention level, or `[]` when the directory is absent. */
function filesIn(dir: URL): string[] {
  const path = fileURLToPath(dir);
  return existsSync(path) ? readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name) : [];
}

describe("the proxy file convention", () => {
  it("has no middleware file left beside proxy.ts", () => {
    // Next 16 fails the build outright when both exist ("Both middleware file
    // … and proxy file … are detected"), so this must be a rename and stay one.
    //
    // It looks for `middleware.<pageExtension>` at the root *and* under src/
    // (build/index.js: `^middleware\.(?:${pageExtensions.join("|")})$`, tested
    // against both convention levels), so checking for the one spelling this
    // branch deleted would miss a middleware.js or a src/middleware.ts.
    const found = [
      ...filesIn(root).map((name) => name),
      ...filesIn(new URL("src/", root)).map((name) => `src/${name}`),
    ].filter((name) => /(^|\/)middleware\.[a-z]+$/.test(name));

    expect(found).toEqual([]);
    expect(existsSync(fileURLToPath(new URL("proxy.ts", root)))).toBe(true);
  });

  it("exports next-intl's handler under the name the convention looks for", async () => {
    // The entry template reads `mod.proxy` for a proxy file and only falls back
    // to `mod.default`; anything else throws "must export a function named
    // `proxy` or a default function" per request rather than at build time.
    const { proxy } = await import("@/proxy");
    expect(proxy).toBe(handler);
    expect(createMiddleware).toHaveBeenCalledWith(routing);
  });

  it("keeps API routes, Next internals and static files out of the matcher", async () => {
    // Compiled by Next's own `getMiddlewareMatchers` rather than compared as a
    // string: the property worth pinning is which paths the negative lookahead
    // lets through, and an assertion that merely restates the source line would
    // pass just as happily for a matcher that had started catching /api.
    //
    // An internal import (next 16.3.5), like the next-intl one in
    // accept-language.negotiation.test.ts. If a future Next moves it, this
    // fails loudly rather than quietly stopping to test anything.
    // The cast is deliberate: the function is exported at runtime but carries
    // an `@internal` tag that keeps it out of the published .d.ts ("required to
    // exclude zod types from the build"), so this declares the slice of it we
    // lean on rather than silencing the checker wholesale.
    const { getMiddlewareMatchers } = (await import(
      "next/dist/build/analysis/get-page-static-info.js"
    )) as unknown as {
      getMiddlewareMatchers: (
        matcher: string[],
        nextConfig: Record<string, never>,
      ) => Array<{ regexp: string }>;
    };
    const { config } = await import("@/proxy");
    const [compiled] = getMiddlewareMatchers(config.matcher, {});
    const matches = new RegExp(compiled.regexp);

    // Locale-prefixing /api would break every route handler, and the lookahead
    // is the only thing preventing it.
    expect(matches.test("/api/register")).toBe(false);
    expect(matches.test("/api/health")).toBe(false);
    // Next internals and anything with a dot — /icon.svg is the one this app
    // actually serves from the root.
    expect(matches.test("/_next/static/chunk.js")).toBe(false);
    expect(matches.test("/icon.svg")).toBe(false);
    // Everything else still has to reach the handler, or there is no locale
    // redirect and no NEXT_LOCALE cookie.
    expect(matches.test("/")).toBe(true);
    for (const locale of routing.locales) {
      expect(matches.test(`/${locale}`)).toBe(true);
      expect(matches.test(`/${locale}/my`)).toBe(true);
    }
  });
});
