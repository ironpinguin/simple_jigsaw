import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Run on everything except API routes, Next internals and files with a dot
  // (e.g. /icon.svg, images) — those must not be locale-prefixed.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
