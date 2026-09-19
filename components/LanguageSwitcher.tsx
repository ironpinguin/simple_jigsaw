"use client";

import { useTransition } from "react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

const LABELS: Record<string, string> = { de: "DE", en: "EN", it: "IT" };

// Switches the locale while staying on the current page. next-intl's
// usePathname/useRouter are locale-aware: the pathname is returned without the
// prefix and router.replace re-applies the chosen one.
//
// `persist` also writes the choice to the signed-in user's row. Clicking here
// is already the statement "this is my language", so it doubles as the setting
// rather than there being a second control on /my that could disagree with it.
// What it buys is the mail whose recipient is not the person making the request
// — an admin notification, a takedown notice — which has no request locale to
// go on; see app/api/account/locale/route.ts. The layout passes it, because it
// is a Server Component that already knows the session; a client-side
// useSession would be a provider and a round trip for one boolean.
export default function LanguageSwitcher({ persist = false }: { persist?: boolean }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function switchTo(next: string) {
    if (next === locale) return;
    // Deliberately not awaited and never blocking the switch: the visitor asked
    // for a different page language, not for a database write, and neither a
    // slow round trip nor a refusal may keep them on the old locale.
    //
    // A refusal is still worth a line. The page changes language either way, so
    // there is nothing on screen to distinguish a stored choice from one that
    // was dropped — and the most likely refusal is a 401 from a tab left open
    // until its session expired, which the route cannot usefully log because it
    // sees one every time. Its own log covers the 500.
    if (persist) {
      fetch("/api/account/locale", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      })
        .then((res) => {
          if (!res.ok) {
            console.error(
              `[lang] the account kept its old mail language: /api/account/locale answered ${res.status}`,
            );
          }
        })
        .catch((err: unknown) => {
          console.error("[lang] storing the locale on the account failed:", err);
        });
    }
    startTransition(() => {
      router.replace(pathname, { locale: next });
    });
  }

  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {routing.locales.map((l) => (
        <button
          key={l}
          type="button"
          className={`lang-option ${l === locale ? "active" : ""}`}
          aria-pressed={l === locale}
          disabled={pending}
          onClick={() => switchTo(l)}
        >
          {LABELS[l] ?? l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
