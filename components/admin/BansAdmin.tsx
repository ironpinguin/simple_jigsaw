"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDateUtc } from "@/lib/dates";
import { tryFetch } from "@/lib/try-fetch";

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
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  /** A row is only safe to render once every field the table reads is there. */
  function isBanRow(value: unknown): value is BanRow {
    const row = value as Partial<BanRow> | null;
    return (
      typeof row?.id === "string" &&
      typeof row.value === "string" &&
      typeof row.type === "string" &&
      typeof row.createdAt === "string"
    );
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await tryFetch("admin", "/api/admin/bans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, type }),
      });
      const data = await res?.json().catch((parseError) => {
        console.error("[admin] the ban response could not be parsed:", parseError);
        return null;
      });
      if (!res?.ok) {
        setErr(data?.error || t("banAddFailed"));
        return;
      }
      setValue("");
      // The ban exists either way — the server said 2xx — so an unusable body
      // is a table that cannot show it, not an add that failed. Saying
      // "adding failed" here would be a lie the admin acts on; pushing the row
      // unchecked puts `undefined` in the list and throws on `b.value` below,
      // blanking the whole page.
      if (!isBanRow(data?.ban)) {
        console.error("[admin] the ban response carried no usable ban");
        // Deliberately never cleared here: the row that went missing is still
        // missing, and a later add that works says nothing about it. Only
        // reloading the page — what the message asks for — rebuilds the table.
        setStale(true);
        return;
      }
      setBans((list) => [data.ban, ...list]);
    } finally {
      // In the finally so a request that never reaches the server cannot leave
      // the form disabled with nothing to explain it.
      setBusy(false);
    }
  }

  async function remove(ban: BanRow) {
    setErr(null);
    setRemovingId(ban.id);
    try {
      const res = await tryFetch("admin", `/api/admin/bans/${ban.id}`, { method: "DELETE" });
      if (res?.ok) {
        setBans((list) => list.filter((b) => b.id !== ban.id));
        return;
      }
      // Without this the row simply stayed: no message, no log, and no way for
      // the admin to tell a refusal from a click that never registered. Named,
      // because one page-level line above a table of rows otherwise leaves them
      // to guess which click it belongs to.
      const data = await res?.json().catch(() => null);
      setErr(data?.error || t("banRemoveFailed", { value: ban.value }));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div>
      <p className="muted">{t("bansDesc")}</p>
      {err && <p className="error">{err}</p>}
      {stale && <p className="error">{t("listStale")}</p>}

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
                <td className="muted">{formatDateUtc(b.createdAt, locale)}</td>
                <td>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={removingId === b.id}
                    onClick={() => remove(b)}
                  >
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
