import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-aware navigation helpers (keep the active locale in links/redirects).
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
