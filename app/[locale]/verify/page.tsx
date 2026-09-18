"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

type State = "pending" | "ok" | "error";

export default function VerifyPage() {
  const t = useTranslations("auth");
  const params = useSearchParams();
  const token = params.get("token");
  // A missing token is knowable from the URL, so it is the initial state rather
  // than something an effect discovers and then corrects: setting it in the
  // effect rendered "pending" first and immediately re-rendered over it, which
  // is the cascade react-hooks/set-state-in-effect warns about (#84).
  const [state, setState] = useState<State>(token ? "pending" : "error");
  const [error, setError] = useState<string | null>(() =>
    token ? null : t("verifyNoToken"),
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (cancelled) return;
      if (res.ok) {
        setState("ok");
      } else {
        const data = await res.json().catch(() => ({}));
        setState("error");
        setError(data.error || t("inviteFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="form card">
      <h1>{t("verifyTitle")}</h1>
      {state === "pending" && <p className="muted">{t("verifyPending")}</p>}
      {state === "ok" && (
        <>
          <p>{t("verifyOk")}</p>
          <Link href="/login" className="button">
            {t("toLogin")}
          </Link>
        </>
      )}
      {state === "error" && (
        <>
          <p className="error">{error}</p>
          <Link href="/register">{t("verifyRetry")}</Link>
        </>
      )}
    </div>
  );
}
