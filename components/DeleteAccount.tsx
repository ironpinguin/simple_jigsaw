"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { signOut } from "next-auth/react";

export default function DeleteAccount() {
  const t = useTranslations("my");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch (err) {
      // Only the network call is caught: a throw from the success handling
      // below must not be reported as a failed request — by then the account
      // may well be gone.
      console.error("[my] account deletion request failed:", err);
      setError(t("deleteAccountFailed"));
      setBusy(false);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? t("deleteAccountFailed"));
      setBusy(false);
      return;
    }

    // The session is a JWT and stays valid until it expires, so it has to be
    // dropped explicitly — otherwise the next request carries a token whose
    // user no longer exists. Stays busy: the page is about to navigate away.
    setPassword("");
    await signOut({ callbackUrl: `/${locale}` });
  }

  if (!open) {
    return (
      <section style={{ marginTop: 48 }}>
        <h2>{t("dangerTitle")}</h2>
        <p className="muted">{t("dangerIntro")}</p>
        <button className="button danger" type="button" onClick={() => setOpen(true)}>
          {t("deleteAccount")}
        </button>
      </section>
    );
  }

  return (
    <section style={{ marginTop: 48 }}>
      <h2>{t("dangerTitle")}</h2>
      <p className="muted">{t("dangerIntro")}</p>
      <form onSubmit={submit} className="card" style={{ maxWidth: 420 }}>
        <label htmlFor="deleteAccountPassword">{t("confirmPassword")}</label>
        <input
          id="deleteAccountPassword"
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <div className="card-actions" style={{ marginTop: 12 }}>
          <button className="button danger" type="submit" disabled={busy}>
            {busy ? t("deleting") : t("confirmDeleteAccount")}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setPassword("");
              setError(null);
            }}
          >
            {t("cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
