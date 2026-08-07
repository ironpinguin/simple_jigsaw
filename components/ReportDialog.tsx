"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  REPORT_CATEGORIES,
  REPORT_MESSAGE_MAX,
  REPORT_MESSAGE_MIN,
  type ReportCategory,
} from "@/lib/reports";

/**
 * "Report this puzzle" — trigger button plus modal form. Works without a
 * session: the endpoint is anonymous by design (the people who find bad
 * content are not necessarily registered).
 */
export default function ReportDialog({ puzzleId }: { puzzleId: string }) {
  const t = useTranslations("report");
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory>("NSFW");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setState("idle");
    setError(null);
    setMessage("");
    setEmail("");
    setCategory("NSFW");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);
    let res: Response | null = null;
    try {
      res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          puzzleId,
          category,
          message: message.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
        }),
      });
    } catch (err) {
      console.error("[report] request failed:", err);
    }
    if (res?.ok) {
      setState("done");
    } else {
      setState("idle");
      // The API answers with a localized, specific message (e.g. "puzzle not
      // found") — show it rather than a generic "try again later" that a
      // retry can never fix. 429 keeps the client wording, matched to the
      // page locale.
      const data = res ? await res.json().catch(() => null) : null;
      setError(res?.status === 429 ? t("tooMany") : (data?.error ?? t("failed")));
    }
  }

  return (
    <>
      <button className="button secondary" type="button" onClick={() => setOpen(true)}>
        {t("reportLink")}
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: 24,
              borderRadius: 8,
              maxWidth: 420,
              width: "90%",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <h2 style={{ marginTop: 0 }}>{t("title")}</h2>
            {state === "done" ? (
              <>
                <p>{t("doneText")}</p>
                <button className="button" type="button" onClick={close}>
                  {t("close")}
                </button>
              </>
            ) : (
              <form onSubmit={submit}>
                <p>{t("intro")}</p>
                {REPORT_CATEGORIES.map((c) => (
                  <label key={c} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="radio"
                      name="category"
                      value={c}
                      checked={category === c}
                      onChange={() => setCategory(c)}
                    />
                    {t(`category${c}`)}
                  </label>
                ))}
                <label style={{ display: "block", marginTop: 12 }}>
                  {t("messageLabel")}
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={4}
                    maxLength={REPORT_MESSAGE_MAX}
                    placeholder={t("messagePlaceholder")}
                    style={{ width: "100%" }}
                  />
                </label>
                <label style={{ display: "block", marginTop: 8 }}>
                  {t("emailLabel")}
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </label>
                <p className="muted">{t("emailHint")}</p>
                {error && <p role="alert">{error}</p>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="button"
                    type="submit"
                    disabled={state === "sending" || message.trim().length < REPORT_MESSAGE_MIN}
                  >
                    {state === "sending" ? t("sending") : t("submit")}
                  </button>
                  <button className="button secondary" type="button" onClick={close}>
                    {t("close")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
