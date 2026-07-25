import type { Metadata } from "next";
import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { isRegistrationEnabled } from "@/lib/registration";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jigsaw — Puzzles aus deinen Bildern",
  description: "Erstelle klassische Puzzles aus eigenen Bildern und löse sie im Browser.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();

  return (
    <html lang="de">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            🧩 Jigsaw
          </Link>
          <nav className="site-nav">
            {session?.user ? (
              <>
                <Link href="/create">Erstellen</Link>
                <Link href="/my">Meine Puzzles</Link>
                {session.user.role === "ADMIN" && <Link href="/admin">Admin</Link>}
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/" });
                  }}
                >
                  <button className="link-button" type="submit">
                    Abmelden
                  </button>
                </form>
              </>
            ) : (
              <>
                <Link href="/login">Anmelden</Link>
                {isRegistrationEnabled() && (
                  <Link href="/register" className="nav-cta">
                    Registrieren
                  </Link>
                )}
              </>
            )}
          </nav>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
