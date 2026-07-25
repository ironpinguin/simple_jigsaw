import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdmin();
  if (!admin) redirect("/");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Administration</h1>
        <nav className="site-nav">
          <Link href="/admin/users">Nutzer</Link>
          <Link href="/admin/bans">Banns</Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
