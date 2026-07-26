"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

interface BanRow {
  id: string;
  value: string;
  type: string;
  createdAt: string;
}

export default function BansAdmin({ initial }: { initial: BanRow[] }) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [bans, setBans] = useState<BanRow[]>(initial);
  const [value, setValue] = useState("");
  const [type, setType] = useState<"EMAIL" | "DOMAIN">("DOMAIN");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const res = await fetch("/api/admin/bans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value, type }),
    });
    setBusy(false);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setBans((list) => [data.ban, ...list]);
      setValue("");
    } else {
      setErr(data.error || t("banAddFailed"));
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/admin/bans/${id}`, { method: "DELETE" });
    if (res.ok) setBans((list) => list.filter((b) => b.id !== id));
  }

  return (
    <div>
      <p className="muted">{t("bansDesc")}</p>
      {err && <p className="error">{err}</p>}

      <form className="card" onSubmit={add} style={{ maxWidth: 520, marginBottom: 24 }}>
        <h3 style={{ marginTop: 0 }}>{t("banAddTitle")}</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 220px" }}>
            <label htmlFor="banValue">
              {type === "EMAIL" ? t("banEmailLabel") : t("banDomainLabel")}
            </label>
            <input
              id="banValue"
              type="text"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="banType">{t("banType")}</label>
            <select id="banType" value={type} onChange={(e) => setType(e.target.value as "EMAIL" | "DOMAIN")}>
              <option value="DOMAIN">{t("banTypeDomain")}</option>
              <option value="EMAIL">{t("banTypeEmail")}</option>
            </select>
          </div>
          <button className="button" type="submit" disabled={busy}>
            {t("banAdd")}
          </button>
        </div>
      </form>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t("banColValue")}</th>
              <th>{t("banColType")}</th>
              <th>{t("banColSince")}</th>
              <th>{t("banColAction")}</th>
            </tr>
          </thead>
          <tbody>
            {bans.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {t("banNone")}
                </td>
              </tr>
            )}
            {bans.map((b) => (
              <tr key={b.id}>
                <td>{b.value}</td>
                <td>{b.type === "EMAIL" ? t("banTypeEmail") : t("banTypeDomain")}</td>
                <td className="muted">{new Date(b.createdAt).toLocaleDateString(locale)}</td>
                <td>
                  <button className="button secondary" type="button" onClick={() => remove(b.id)}>
                    {t("banRemove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
