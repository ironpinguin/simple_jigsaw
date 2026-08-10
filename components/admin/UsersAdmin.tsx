"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

export interface UserRow {
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

  // Every handler below brackets its request in try/finally. A rejected fetch —
  // offline, the container restarted mid-request — reaches neither the ok nor the
  // error branch, so without it `busy` would stay true for the life of the page:
  // both forms and every row's re-invite button dead, and no message saying why.
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail }),
      });
      const data = await res.json().catch(() => ({}));
      // Both paths can leave a row the admin needs to see: the create path makes
      // one before it sends, so a failure leaves it behind, and the re-invite
      // path acts on one that was there already. Refresh either way, or the
      // account the admin is being told to invite again is not on screen to
      // invite.
      refresh();
      if (res.ok) {
        // The same form re-invites when the address belongs to an account that
        // never activated, so which of the two happened comes from the route.
        flash(t(data.reinvited ? "reinviteSent" : "inviteSent", { email: inviteEmail }), null);
        setInviteEmail("");
      } else {
        flash(null, data.error || t("inviteFailed"));
      }
    } catch (error) {
      console.error("[admin] invite request failed:", error);
      flash(null, t("inviteFailed"));
    } finally {
      setBusy(false);
    }
  }

  // Sends a fresh invite to a row that never activated, so the admin does not
  // have to retype an address that is already on screen — or delete the account
  // to get it back, which was the only recovery before.
  //
  // Destructive in a way the row does not show: the route revokes the
  // outstanding link, and for most invited rows that link is still valid and
  // simply unclicked. So it confirms first, the way `remove` does, and both the
  // prompt and the flash say that the earlier link stops working — otherwise the
  // admin has no reason to connect this click to the invitee reporting a dead
  // link later on.
  async function reinvite(u: UserRow) {
    if (!confirm(t("confirmReinvite", { email: u.email }))) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email }),
      });
      const data = await res.json().catch(() => ({}));
      refresh();
      flash(
        res.ok ? t("reinviteSent", { email: u.email }) : null,
        res.ok ? null : data.error || t("inviteFailed"),
      );
    } catch (error) {
      console.error("[admin] re-invite request failed:", error);
      flash(null, t("inviteFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function createDirect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, password: newPassword, role: newRole }),
      });
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
    } catch (error) {
      console.error("[admin] create request failed:", error);
      flash(null, t("createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRole(u: UserRow) {
    const role = u.role === "ADMIN" ? "USER" : "ADMIN";
    setBusy(true);
    try {
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
    } catch (error) {
      console.error("[admin] role change failed:", error);
      flash(null, t("changeFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(u: UserRow) {
    if (!confirm(t("confirmDeleteUser", { email: u.email }))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        flash(t("accountDeleted", { email: u.email }), null);
        setUsers((list) => list.filter((x) => x.id !== u.id));
      } else {
        flash(null, data.error || t("deleteUserFailed"));
      }
    } catch (error) {
      console.error("[admin] delete request failed:", error);
      flash(null, t("deleteUserFailed"));
    } finally {
      setBusy(false);
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
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => toggleRole(u)}
                    >
                      {u.role === "ADMIN" ? t("removeAdmin") : t("makeAdmin")}
                    </button>
                    {/* Only for a row that never activated. For a row that has a
                        password the route refuses — 409, or 403 if the address
                        has meanwhile been banned — so offering it would promise
                        something that cannot happen. */}
                    {!u.hasPassword && (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => reinvite(u)}
                      >
                        {t("reinvite")}
                      </button>
                    )}
                    <button
                      className="button danger"
                      type="button"
                      disabled={busy || u.id === currentUserId}
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
