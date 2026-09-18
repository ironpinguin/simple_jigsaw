"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";

export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") || "/my";
  const passwordChanged = params.get("changed") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      setError(t("loginError"));
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>{t("loginTitle")}</h1>
      {passwordChanged && <p className="muted">{t("passwordChangedSignIn")}</p>}
      {error && <p className="error">{error}</p>}
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
        <label htmlFor="password">{t("password")}</label>
        <input
          id="password"
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <button className="button" type="submit" disabled={loading}>
        {loading ? t("loginLoading") : t("loginSubmit")}
      </button>
      <p className="muted">
        {t("noAccount")} <Link href="/register">{t("registerLink")}</Link>
      </p>
    </form>
  );
}
