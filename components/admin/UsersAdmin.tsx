"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

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
  const t = useTranslations("admin");
  const locale = useLocale();
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

  function roleLabel(role: string) {
    return role === "ADMIN" ? t("roleAdmin") : t("roleUser");
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
      flash(t("inviteSent", { email: inviteEmail }), null);
      setInviteEmail("");
      refresh();
    } else {
      flash(null, data.error || t("inviteFailed"));
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
      flash(t("accountCreated", { email: newEmail }), null);
      setNewEmail("");
      setNewPassword("");
      setNewRole("USER");
      refresh();
    } else {
      flash(null, data.error || t("createFailed"));
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
      flash(t("roleChanged", { email: u.email, role: roleLabel(role) }), null);
      refresh();
    } else {
      flash(null, data.error || t("changeFailed"));
    }
  }

  async function remove(u: UserRow) {
    if (!confirm(t("confirmDeleteUser", { email: u.email }))) return;
    const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      flash(t("accountDeleted", { email: u.email }), null);
      setUsers((list) => list.filter((x) => x.id !== u.id));
    } else {
      flash(null, data.error || t("deleteUserFailed"));
    }
  }

  return (
    <div>
      {msg && <p style={{ color: "var(--success)" }}>{msg}</p>}
      {err && <p className="error">{err}</p>}

      <div className="grid-cards" style={{ marginBottom: 24 }}>
        <form className="card" onSubmit={invite}>
          <h3 style={{ marginTop: 0 }}>{t("inviteTitle")}</h3>
          <label htmlFor="inviteEmail">{t("email")}</label>
          <input
            id="inviteEmail"
            type="email"
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <button className="button" type="submit" disabled={busy} style={{ marginTop: 12 }}>
            {t("sendInvite")}
          </button>
        </form>

        <form className="card" onSubmit={createDirect}>
          <h3 style={{ marginTop: 0 }}>{t("directTitle")}</h3>
          <label htmlFor="newEmail">{t("email")}</label>
          <input
            id="newEmail"
            type="email"
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <label htmlFor="newPassword" style={{ marginTop: 8 }}>
            {t("startPassword")}
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
            {t("role")}
          </label>
          <select id="newRole" value={newRole} onChange={(e) => setNewRole(e.target.value as "USER" | "ADMIN")}>
            <option value="USER">{t("roleUser")}</option>
            <option value="ADMIN">{t("roleAdmin")}</option>
          </select>
          <button className="button" type="submit" disabled={busy} style={{ marginTop: 12 }}>
            {t("createAccount")}
          </button>
        </form>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("colEmail")}</th>
              <th>{t("colRole")}</th>
              <th>{t("colStatus")}</th>
              <th>{t("colCreated")}</th>
              <th>{t("colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.id === currentUserId && <span className="muted"> {t("you")}</span>}
                </td>
                <td>{roleLabel(u.role)}</td>
                <td className="muted">
                  {u.verified
                    ? t("statusVerified")
                    : u.hasPassword
                      ? t("statusUnverified")
                      : t("statusInvited")}
                </td>
                <td className="muted">{new Date(u.createdAt).toLocaleDateString(locale)}</td>
                <td>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="button secondary" type="button" onClick={() => toggleRole(u)}>
                      {u.role === "ADMIN" ? t("removeAdmin") : t("makeAdmin")}
                    </button>
                    <button
                      className="button danger"
                      type="button"
                      disabled={u.id === currentUserId}
                      onClick={() => remove(u)}
                    >
                      {t("delete")}
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
