"use client";

import { useState } from "react";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  verified: boolean;
  hasPassword: boolean;
  createdAt: string;
}

export default function UsersAdmin({
  initial,
  currentUserId,
}: {
  initial: UserRow[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<UserRow[]>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // create-forms state
  const [inviteEmail, setInviteEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"USER" | "ADMIN">("USER");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const res = await fetch("/api/admin/users");
    if (res.ok) setUsers((await res.json()).users);
  }

  function flash(ok: string | null, error: string | null) {
    setMsg(ok);
    setErr(error);
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/admin/users/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      flash(`Einladung an ${inviteEmail} verschickt.`, null);
      setInviteEmail("");
      refresh();
    } else {
      flash(null, data.error || "Einladung fehlgeschlagen.");
    }
  }

  async function createDirect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: newEmail, password: newPassword, role: newRole }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      flash(`Konto ${newEmail} angelegt.`, null);
      setNewEmail("");
      setNewPassword("");
      setNewRole("USER");
      refresh();
    } else {
      flash(null, data.error || "Anlegen fehlgeschlagen.");
    }
  }

  async function toggleRole(u: UserRow) {
    const role = u.role === "ADMIN" ? "USER" : "ADMIN";
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      flash(`Rolle von ${u.email} → ${role}.`, null);
      refresh();
    } else {
      flash(null, data.error || "Änderung fehlgeschlagen.");
    }
  }

  async function remove(u: UserRow) {
    if (!confirm(`Konto ${u.email} wirklich löschen?`)) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      flash(`Konto ${u.email} gelöscht.`, null);
      setUsers((list) => list.filter((x) => x.id !== u.id));
    } else {
      flash(null, data.error || "Löschen fehlgeschlagen.");
    }
  }

  return (
    <div>
      {msg && <p style={{ color: "var(--success)" }}>{msg}</p>}
      {err && <p className="error">{err}</p>}

      <div className="grid-cards" style={{ marginBottom: 24 }}>
        <form className="card" onSubmit={invite}>
          <h3 style={{ marginTop: 0 }}>Einladen (per E-Mail)</h3>
          <label htmlFor="inviteEmail">E-Mail</label>
          <input
            id="inviteEmail"
            type="email"
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <button className="button" type="submit" disabled={busy} style={{ marginTop: 12 }}>
            Einladung senden
          </button>
        </form>

        <form className="card" onSubmit={createDirect}>
          <h3 style={{ marginTop: 0 }}>Direkt anlegen</h3>
          <label htmlFor="newEmail">E-Mail</label>
          <input
            id="newEmail"
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <label htmlFor="newPassword" style={{ marginTop: 8 }}>
            Startpasswort (min. 8)
          </label>
          <input
            id="newPassword"
            type="text"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <label htmlFor="newRole" style={{ marginTop: 8 }}>
            Rolle
          </label>
          <select id="newRole" value={newRole} onChange={(e) => setNewRole(e.target.value as "USER" | "ADMIN")}>
            <option value="USER">User</option>
            <option value="ADMIN">Admin</option>
          </select>
          <button className="button" type="submit" disabled={busy} style={{ marginTop: 12 }}>
            Konto anlegen
          </button>
        </form>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>E-Mail</th>
              <th>Rolle</th>
              <th>Status</th>
              <th>Erstellt</th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.id === currentUserId && <span className="muted"> (du)</span>}
                </td>
                <td>{u.role}</td>
                <td className="muted">
                  {u.verified ? "bestätigt" : u.hasPassword ? "unbestätigt" : "eingeladen"}
                </td>
                <td className="muted">{new Date(u.createdAt).toLocaleDateString("de-DE")}</td>
                <td>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="button secondary" type="button" onClick={() => toggleRole(u)}>
                      {u.role === "ADMIN" ? "Admin entfernen" : "Zu Admin"}
                    </button>
                    <button
                      className="button danger"
                      type="button"
                      disabled={u.id === currentUserId}
                      onClick={() => remove(u)}
                    >
                      Löschen
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
