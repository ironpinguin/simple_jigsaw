"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { isReportCategory, type ReportDecision, type ReportStatus } from "@/lib/reports";

export interface ReportRow {
  id: string;
  puzzleId: string;
  puzzleTitle: string;
  /** Raw DB string: an unknown value renders as itself rather than crashing. */
  category: string;
  message: string;
  reporterEmail: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
  puzzleExists: boolean;
}

export default function ReportsAdmin({
  initialOpen,
  initialResolved,
}: {
  initialOpen: ReportRow[];
  initialResolved: ReportRow[];
}) {
  const t = useTranslations("admin");
  const [openReports, setOpenReports] = useState(initialOpen);
  const [resolved, setResolved] = useState(initialResolved);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Catches only the network call — a bug in the response handling must not
  // be reported as a failed request (same pattern as MyPuzzles).
  async function tryFetch(input: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await fetch(input, init);
    } catch (err) {
      console.error(`[admin] request to ${input} failed:`, err);
      return null;
    }
  }

  // Mirrors what the server did: move the reports out of the open list,
  // stamp decision + timestamp, drop the reporter contact (anonymized).
  function resolveLocally(ids: Set<string>, status: ReportDecision) {
    const now = new Date().toISOString();
    const affected = openReports
      .filter((r) => ids.has(r.id))
      .map((r) => ({
        ...r,
        status,
        resolvedAt: now,
        reporterEmail: null,
        puzzleExists: status === "TAKEDOWN" ? false : r.puzzleExists,
      }));
    setOpenReports((list) => list.filter((r) => !ids.has(r.id)));
    setResolved((list) => [...affected, ...list]);
  }

  async function takedown(report: ReportRow) {
    if (!confirm(t("confirmTakedown"))) return;
    setBusyId(report.id);
    try {
      const res = await tryFetch(`/api/admin/puzzles/${report.puzzleId}`, { method: "DELETE" });
      if (res?.ok) {
        // The takedown succeeded, but the owner may not know: tell the admin
        // to contact them manually instead of pretending everything worked.
        // Anything other than an explicit true counts as "not notified" — an
        // unreadable body must not silently pass as a delivered notice.
        const data = await res.json().catch((err) => {
          console.error("[admin] takedown response could not be parsed:", err);
          return null;
        });
        if (data?.ownerNotified !== true) {
          alert(t("ownerNotifyFailed"));
        }
        // One takedown resolves every open report of the same puzzle.
        resolveLocally(
          new Set(openReports.filter((r) => r.puzzleId === report.puzzleId).map((r) => r.id)),
          "TAKEDOWN",
        );
      } else {
        const data = await res?.json().catch(() => null);
        alert(data?.error ?? t("takedownFailed"));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(report: ReportRow) {
    setBusyId(report.id);
    try {
      const res = await tryFetch(`/api/admin/reports/${report.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      if (res?.ok) {
        resolveLocally(new Set([report.id]), "DISMISSED");
      } else {
        const data = await res?.json().catch(() => null);
        alert(data?.error ?? t("dismissFailed"));
      }
    } finally {
      setBusyId(null);
    }
  }

  function categoryLabel(category: string) {
    // Fall back to the raw string for any value outside the canonical set
    // (future or hand-edited data), so a row never hits a missing-translation
    // key and crashes the queue.
    return isReportCategory(category) ? t(`category${category}`) : category;
  }

  return (
    <div>
      <h2>{t("reportsOpenTitle")}</h2>
      {openReports.length === 0 && <p className="muted">{t("reportsEmpty")}</p>}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 12 }}>
        {openReports.map((r) => (
          <li key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong>{categoryLabel(r.category)}</strong>
              {r.puzzleExists ? (
                <Link href={`/puzzle/${r.puzzleId}`}>{r.puzzleTitle}</Link>
              ) : (
                <span>
                  {r.puzzleTitle} — {t("reportPuzzleDeleted")}
                </span>
              )}
              <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <p style={{ whiteSpace: "pre-wrap" }}>{r.message}</p>
            {r.reporterEmail && (
              <p className="muted">
                {t("reporterContact")}: {r.reporterEmail}
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {r.puzzleExists && (
                <button
                  className="button"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => takedown(r)}
                >
                  {t("takedown")}
                </button>
              )}
              <button
                className="button secondary"
                type="button"
                disabled={busyId !== null}
                onClick={() => dismiss(r)}
              >
                {t("dismiss")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>{t("reportsResolvedTitle")}</h2>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8, opacity: 0.7 }}>
        {resolved.map((r) => (
          <li key={r.id}>
            <strong>{r.status === "TAKEDOWN" ? t("decisionTakedown") : t("decisionDismissed")}</strong>{" "}
            — {categoryLabel(r.category)} — {r.puzzleTitle}
            {r.resolvedAt && (
              <span className="muted"> ({new Date(r.resolvedAt).toLocaleString()})</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
