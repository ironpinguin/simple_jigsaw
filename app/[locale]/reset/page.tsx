"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

export default function ResetPage() {
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
    try {
      const res = await fetch("/api/account/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t("resetFailed"));
      }
    } catch {
      // fetch rejects without a response when the network fails.
      setError(t("resetFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="form card">
        <h1>{t("resetTitle")}</h1>
        <p className="error">{t("verifyNoToken")}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="form card">
        <h1>{t("resetTitle")}</h1>
        <p>{t("resetDone")}</p>
        <Link href="/login" className="button">
          {t("toLogin")}
        </Link>
      </div>
    );
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>{t("resetTitle")}</h1>
      {error && <p className="error">{error}</p>}
      <div>
        <label htmlFor="password">{t("passwordMin")}</label>
        <input
          id="password"
          type="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <button className="button" type="submit" disabled={loading}>
        {loading ? t("resetSaving") : t("resetSubmit")}
      </button>
    </form>
  );
}
