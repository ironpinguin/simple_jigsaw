"use client";

import { useTransition } from "react";
import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

const LABELS: Record<string, string> = { de: "DE", en: "EN", it: "IT" };

// Switches the locale while staying on the current page. next-intl's
// usePathname/useRouter are locale-aware: the pathname is returned without the
// prefix and router.replace re-applies the chosen one.
export default function LanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function switchTo(next: string) {
    if (next === locale) return;
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
