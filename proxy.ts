import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// Next 16 renamed the middleware file convention to "proxy" (middleware.ts
// still works but warns on every `next dev` and `next build`). Only the
// filename and the export name move: next-intl 4.13.5 publishes no ./proxy
// subpath, so the handler is still `next-intl/middleware`, and the entry
// template treats both conventions identically apart from the export it looks
// for — `proxy` here, with a default export as the back-compat fallback.
//
// The one real behaviour change: a proxy always runs on the Node.js runtime,
// where middleware.ts defaulted to Edge. Having both files at once is a build
// error, so this has to stay a rename.
export const proxy = createMiddleware(routing);

export const config = {
  // Run on everything except API routes, Next internals and files with a dot
  // (e.g. /icon.svg, images) — those must not be locale-prefixed.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
