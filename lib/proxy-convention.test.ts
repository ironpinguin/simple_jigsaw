import { existsSync } from "node:fs";
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

describe("the proxy file convention", () => {
  it("has no middleware.ts left beside proxy.ts", () => {
    // Next 16 fails the build outright when both exist ("Both middleware file
    // … and proxy file … are detected"), so this must be a rename and stay one.
    expect(existsSync(fileURLToPath(new URL("proxy.ts", root)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL("middleware.ts", root)))).toBe(false);
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
    // Locale-prefixing /api would break every route handler; the negative
    // lookahead is the only thing preventing it.
    const { config } = await import("@/proxy");
    expect(config.matcher).toEqual(["/((?!api|_next|_vercel|.*\\..*).*)"]);
  });
});
