"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

export default function InvitePage() {
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
      setError("Kein Token angegeben.");
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
      setError(data.error || "Aktivierung fehlgeschlagen.");
    }
  }

  if (done) {
    return (
      <div className="form card">
        <h1>Konto aktiviert</h1>
        <p>Dein Passwort ist gesetzt. Du kannst dich jetzt anmelden.</p>
        <Link href="/login" className="button">
          Zur Anmeldung
        </Link>
      </div>
    );
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>Einladung annehmen</h1>
      <p className="muted">Setze ein Passwort, um dein Konto zu aktivieren.</p>
      {error && <p className="error">{error}</p>}
      <div>
        <label htmlFor="password">Passwort (min. 8 Zeichen)</label>
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
        {loading ? "Wird aktiviert…" : "Konto aktivieren"}
      </button>
    </form>
  );
}
