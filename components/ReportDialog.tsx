"use client";

import { useEffect, useId, useRef, useState } from "react";
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
 *
 * Passing `open` makes it controlled: no trigger of its own, for a caller that
 * offers the action elsewhere (the solve page's overflow menu). That caller then
 * owns where focus goes on close, in `onClose` — required with `open`, since
 * without it nothing could ever close the dialog.
 */
export default function ReportDialog({
  puzzleId,
  open: controlledOpen,
  onClose,
}: { puzzleId: string } & (
  | { open?: undefined; onClose?: undefined }
  | { open: boolean; onClose: () => void }
)) {
  const t = useTranslations("report");
  const controlled = controlledOpen !== undefined;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? controlledOpen : ownOpen;
  const [category, setCategory] = useState<ReportCategory>("NSFW");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // aria-modal tells assistive tech the page behind is inert, so focus has to
  // actually be in here — and has to come back to the trigger on close, or a
  // keyboard user restarts at the top of the page.
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  function close() {
    setState("idle");
    setError(null);
    setMessage("");
    setEmail("");
    setCategory("NSFW");
    if (controlled) {
      onClose?.();
    } else {
      setOwnOpen(false);
      triggerRef.current?.focus();
    }
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
      // retry can never fix. 429 is the exception: the client's own phrasing
      // of the rate limit is friendlier than the API's.
      const data = res ? await res.json().catch(() => null) : null;
      setError(res?.status === 429 ? t("tooMany") : (data?.error ?? t("failed")));
    }
  }

  return (
    <>
      {!controlled && (
        <button
          ref={triggerRef}
          className="button secondary"
          type="button"
          onClick={() => setOwnOpen(true)}
        >
          {t("reportLink")}
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          ref={dialogRef}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
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
            <h2 id={titleId} style={{ marginTop: 0 }}>
              {t("title")}
            </h2>
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
