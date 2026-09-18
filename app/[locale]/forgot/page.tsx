"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

export default function ForgotPage() {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFailed(false);
    setLoading(true);
    try {
      await fetch("/api/account/password/reset-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // The endpoint answers 200 the same way for every outcome — unknown
      // address, banned address, rate-limited, mail sent — so this page must
      // not branch on the body either; it only distinguishes "the request
      // reached the server" from "it didn't".
      setDone(true);
    } catch {
      // fetch rejects without a response when the network fails.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="form card">
        <h1>{t("forgotTitle")}</h1>
        <p>{t("forgotDone")}</p>
      </div>
    );
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>{t("forgotTitle")}</h1>
      <p className="muted">{t("forgotIntro")}</p>
      {failed && <p className="error">{t("forgotFailed")}</p>}
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
      <button className="button" type="submit" disabled={loading}>
        {loading ? t("forgotSending") : t("forgotSubmit")}
      </button>
      <p className="muted">
        <Link href="/login">{t("toLogin")}</Link>
      </p>
    </form>
  );
}
