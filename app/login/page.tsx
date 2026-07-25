"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") || "/my";

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
      setError("E-Mail oder Passwort ist falsch.");
      return;
    }
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={onSubmit}>
      <h1>Anmelden</h1>
      {error && <p className="error">{error}</p>}
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
        <label htmlFor="password">Passwort</label>
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
        {loading ? "Anmelden…" : "Anmelden"}
      </button>
      <p className="muted">
        Noch kein Konto? <Link href="/register">Registrieren</Link>
      </p>
    </form>
  );
}
