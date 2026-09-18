"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

export default function ChangePassword() {
  const t = useTranslations("my");
  const locale = useLocale();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/account/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    } catch (err) {
      // Only the request is caught. A throw from the success handling below
      // must not be reported as a failed change — by then the password is
      // already different, and telling the user otherwise is the worse lie.
      console.error("[my] password change request failed:", err);
      setError(t("changePasswordFailed"));
      setBusy(false);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? t("changePasswordFailed"));
      setBusy(false);
      return;
    }

    // Every session issued before the change is now stale, including this one,
    // so this device signs in again like the others. The notice on /login is
    // what tells the user that was deliberate.
    setCurrentPassword("");
    setNewPassword("");
    await signOut({ callbackUrl: `/${locale}/login?changed=1` });
  }

  return (
    <section style={{ marginTop: 48 }}>
      <h2>{t("passwordTitle")}</h2>
      <p className="muted">{t("passwordIntro")}</p>
      <form onSubmit={submit}>
        <label htmlFor="current-password">{t("currentPassword")}</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />

        <label htmlFor="new-password">{t("newPassword")}</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />

        {error && <p className="error">{error}</p>}

        <button className="button" type="submit" disabled={busy}>
          {busy ? t("changingPassword") : t("changePassword")}
        </button>
      </form>
    </section>
  );
}
