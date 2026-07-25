"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type State = "pending" | "ok" | "error";

export default function VerifyPage() {
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<State>("pending");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("error");
      setError("Kein Token angegeben.");
      return;
    }
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
        setError(data.error || "Bestätigung fehlgeschlagen.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="form card">
      <h1>E-Mail-Bestätigung</h1>
      {state === "pending" && <p className="muted">Wird bestätigt…</p>}
      {state === "ok" && (
        <>
          <p>Deine E-Mail-Adresse wurde bestätigt. Du kannst dich jetzt anmelden.</p>
          <Link href="/login" className="button">
            Zur Anmeldung
          </Link>
        </>
      )}
      {state === "error" && (
        <>
          <p className="error">{error}</p>
          <Link href="/register">Erneut registrieren</Link>
        </>
      )}
    </div>
  );
}
