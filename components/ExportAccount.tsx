"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

// Self-service access (GDPR Art. 15). The download goes through fetch rather
// than a plain <a href> so a refusal — 429 above all — can be shown as a
// translated message instead of dropping the user on a page of raw JSON.
export default function ExportAccount() {
  const t = useTranslations("my");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/account/export");
    } catch (err) {
      // Only the request is caught; a throw from the save below must not be
      // reported as a failed request.
      console.error("[my] data export request failed:", err);
      setError(t("exportFailed"));
      setBusy(false);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? t("exportFailed"));
      setBusy(false);
      return;
    }

    const url = URL.createObjectURL(await res.blob());
    try {
      const link = document.createElement("a");
      link.href = url;
      // The server names the file too, but a Content-Disposition filename is
      // not visible to fetch, so it is repeated here.
      link.download = `jigsaw-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
    } finally {
      // The click has already handed the blob to the browser, so nothing is
      // lost by releasing it — and holding it would pin the whole export in
      // memory for as long as the page lives.
      URL.revokeObjectURL(url);
    }

    setBusy(false);
  }

  return (
    <section style={{ marginTop: 48 }}>
      <h2>{t("exportTitle")}</h2>
      <p className="muted">{t("exportIntro")}</p>
      {error && <p className="error">{error}</p>}
      <button className="button secondary" type="button" disabled={busy} onClick={download}>
        {busy ? t("exporting") : t("exportData")}
      </button>
    </section>
  );
}
