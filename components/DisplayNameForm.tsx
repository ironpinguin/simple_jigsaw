"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { tryFetch } from "@/lib/try-fetch";
import { DISPLAY_NAME_MAX } from "@/lib/competition";

/** The public leaderboard name on /my — set at the first entry, changeable here. */
export default function DisplayNameForm({ initial }: { initial: string | null }) {
  const t = useTranslations("competition");
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await tryFetch("competition", "/api/account/display-name", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: value }),
      });
      if (res?.status === 401) return router.push("/login?callbackUrl=/my");
      const data = res ? await res.json().catch(() => null) : null;
      if (!res?.ok || typeof data?.displayName !== "string") {
        return setError(data?.error ?? t("displayNameFailed"));
      }
      setSaved(data.displayName);
      setValue(data.displayName);
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ marginTop: 48 }}>
      <h2>{t("displayNameTitle")}</h2>
      <p className="muted">{saved ? t("displayNameIntro") : t("displayNameUnset")}</p>
      <form onSubmit={submit}>
        <label htmlFor="display-name">{t("displayName")}</label>
        <input
          id="display-name"
          type="text"
          value={value}
          maxLength={DISPLAY_NAME_MAX}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="nickname"
        />
        {error && <p className="error">{error}</p>}
        {done && <p role="status">{t("displayNameSaved")}</p>}
        <button className="button" type="submit" disabled={busy || value.trim() === (saved ?? "")}>
          {t("saveDisplayName")}
        </button>
      </form>
    </section>
  );
}
