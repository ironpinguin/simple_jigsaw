"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Registrierung fehlgeschlagen.");
      setLoading(false);
      return;
    }

    // Auto-login after successful registration.
    await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    router.push("/create");
    router.refresh();
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
