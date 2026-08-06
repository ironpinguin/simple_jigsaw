"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export default function RegisterForm() {
  const t = useTranslations("auth");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, termsAccepted }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t("registerFailed"));
        return;
      }

      // No auto-login: the account must confirm its email first.
      setDone(true);
    } catch {
      // fetch rejects without a response when the network fails.
      setError(t("registerFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="form card">
        <h1>{t("registerDoneTitle")}</h1>
        <p>{t("registerDoneText", { email })}</p>
        <p className="muted">
          <Link href="/login">{t("toLogin")}</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>{t("registerTitle")}</h1>
      {error && <p className="error">{error}</p>}
      <div>
        <label htmlFor="name">{t("nameOptional")}</label>
        <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="email">{t("email")}</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </div>
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
      <div className="checkbox-row">
        <input
          id="terms"
          type="checkbox"
          required
          checked={termsAccepted}
          onChange={(e) => setTermsAccepted(e.target.checked)}
        />
        <label htmlFor="terms">
          {t.rich("acceptTerms", {
            terms: (chunks) => (
              <Link href="/legal/terms" target="_blank" rel="noopener noreferrer">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/legal/privacy" target="_blank" rel="noopener noreferrer">
                {chunks}
              </Link>
            ),
          })}
        </label>
      </div>
      <button className="button" type="submit" disabled={loading}>
        {loading ? t("registerLoading") : t("registerSubmit")}
      </button>
      <p className="muted">
        {t("haveAccount")} <Link href="/login">{t("loginLink")}</Link>
      </p>
    </form>
  );
}
