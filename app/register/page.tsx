"use client";

import { useState } from "react";
import Link from "next/link";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    setLoading(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Registrierung fehlgeschlagen.");
      return;
    }

    // No auto-login: the account must confirm its email first.
    setDone(true);
  }

  if (done) {
    return (
      <div className="form card">
        <h1>Fast geschafft</h1>
        <p>
          Wir haben dir eine Bestätigungs-E-Mail an <strong>{email}</strong> geschickt.
          Klicke den Link darin, um dein Konto zu aktivieren. Danach kannst du dich anmelden.
        </p>
        <p className="muted">
          <Link href="/login">Zur Anmeldung</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>Registrieren</h1>
      {error && <p className="error">{error}</p>}
      <div>
        <label htmlFor="name">Name (optional)</label>
        <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label htmlFor="email">E-Mail</label>
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
        {loading ? "Konto wird erstellt…" : "Konto erstellen"}
      </button>
      <p className="muted">
        Schon registriert? <Link href="/login">Anmelden</Link>
      </p>
    </form>
  );
}
