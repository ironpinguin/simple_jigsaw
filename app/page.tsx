import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function HomePage() {
  const session = await auth();

  return (
    <div>
      <section className="hero">
        <h1>Puzzles aus deinen eigenen Bildern</h1>
        <p>
          Lade ein Bild hoch, wähle die Teile-Anzahl und löse dein persönliches
          Puzzle direkt im Browser — mit echten, ineinandergreifenden Puzzleteilen.
          Teile den Link, damit auch andere mitpuzzeln können.
        </p>
        {session?.user ? (
          <Link href="/create" className="button">
            Neues Puzzle erstellen
          </Link>
        ) : (
          <Link href="/register" className="button">
            Kostenlos loslegen
          </Link>
        )}
      </section>

      <section className="card">
        <h2>So funktioniert&apos;s</h2>
        <ol className="muted">
          <li>Registrieren und anmelden.</li>
          <li>Eigenes Bild hochladen (JPG, PNG oder WebP).</li>
          <li>Teile-Anzahl wählen: 12, 48, 108 oder 300.</li>
          <li>Puzzle speichern und den Link teilen — Lösen geht auch ohne Konto.</li>
        </ol>
      </section>
    </div>
  );
}
