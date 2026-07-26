"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export default function InvitePage() {
  const t = useTranslations("auth");
  const params = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError(t("verifyNoToken"));
      return;
    }
    setLoading(true);
    const res = await fetch("/api/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setLoading(false);
    if (res.ok) {
      setDone(true);
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || t("inviteFailed"));
    }
  }

  if (done) {
    return (
      <div className="form card">
        <h1>{t("inviteDoneTitle")}</h1>
        <p>{t("inviteDoneText")}</p>
        <Link href="/login" className="button">
          {t("toLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>{t("inviteTitle")}</h1>
      <p className="muted">{t("inviteSub")}</p>
      {error && <p className="error">{error}</p>}
      <div>
        <label htmlFor="password">{t("passwordMin")}</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <button className="button" type="submit" disabled={loading}>
        {loading ? t("inviteLoading") : t("inviteSubmit")}
      </button>
    </form>
  );
}
