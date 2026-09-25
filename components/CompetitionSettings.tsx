"use client";

import { useId, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Trophy } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { tryFetch } from "@/lib/try-fetch";
import { PIECE_PRESETS } from "@/lib/puzzle/grid";
import { competitionPhase } from "@/lib/competition";
import { fromLocalInput, toLocalInput } from "@/lib/local-datetime";

export interface OwnerCompetition {
  pieceCount: number;
  startsAt: string | null;
  endsAt: string | null;
  entries: number;
}

/**
 * The owner's side of a competition (#119), inside a puzzle's card on /my:
 * a summary line, and a form to start, change or end it.
 */
export default function CompetitionSettings({
  puzzleId,
  isPublic,
  defaultPieceCount,
  initial,
}: {
  puzzleId: string;
  isPublic: boolean;
  /** Offered for a new competition: what the puzzle was created with. */
  defaultPieceCount: number;
  initial: OwnerCompetition | null;
}) {
  const t = useTranslations("competition");
  const format = useFormatter();
  const router = useRouter();
  const formId = useId();
  const [competition, setCompetition] = useState(initial);
  const [open, setOpen] = useState(false);
  const [pieceCount, setPieceCount] = useState(initial?.pieceCount ?? defaultPieceCount);
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial?.endsAt ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  function summary(c: OwnerCompetition): string {
    // The phase is read from the clock at render; a card left open across the
    // start or end date shows the old phase until the page is reloaded.
    const phase = competitionPhase(
      {
        startsAt: c.startsAt ? new Date(c.startsAt) : null,
        endsAt: c.endsAt ? new Date(c.endsAt) : null,
      },
      new Date(),
    );
    const entries = t("entries", { count: c.entries });
    if (phase === "UPCOMING") return `${t("startsOn", { date: when(c.startsAt!) })} · ${entries}`;
    if (phase === "CLOSED") return `${t("endedOn", { date: when(c.endsAt!) })} · ${entries}`;
    return c.endsAt
      ? `${t("runsUntil", { date: when(c.endsAt) })} · ${entries}`
      : `${t("running")} · ${entries}`;
  }

  async function fail(res: Response | null, fallback: string) {
    if (res?.status === 401) {
      router.push("/login?callbackUrl=/my");
      return;
    }
    const data = res ? await res.json().catch(() => null) : null;
    setError(data?.error ?? fallback);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await tryFetch("competition", `/api/puzzles/${puzzleId}/competition`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pieceCount,
          startsAt: fromLocalInput(startsAt),
          endsAt: fromLocalInput(endsAt),
        }),
      });
      if (!res?.ok) return fail(res, t("saveFailed"));
      const data = await res.json().catch(() => null);
      const saved = data?.competition;
      if (!saved || typeof saved.pieceCount !== "number") {
        console.error("[competition] PUT answered 200 without a competition:", data);
        return setError(t("saveFailed"));
      }
      setCompetition({ ...saved, entries: competition?.entries ?? 0 });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (!confirm(t("confirmEnd"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tryFetch("competition", `/api/puzzles/${puzzleId}/competition`, {
        method: "DELETE",
      });
      if (!res?.ok) return fail(res, t("endFailed"));
      setCompetition(null);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  // The piece count cannot change under entries — the API refuses it, and the
  // form says so instead of offering it.
  const countLocked = (competition?.entries ?? 0) > 0;

  return (
    <div className="competition-settings">
      {competition && (
        <p className="muted" style={{ margin: 0 }}>
          <Trophy size={14} aria-hidden="true" /> {summary(competition)}
        </p>
      )}
      {!open ? (
        <button
          className="button secondary"
          type="button"
          disabled={!isPublic}
          title={isPublic ? undefined : t("needsPublic")}
          onClick={() => setOpen(true)}
        >
          {competition ? t("edit") : t("start")}
        </button>
      ) : (
        <form onSubmit={save} className="competition-form">
          <label htmlFor={`${formId}-count`}>{t("pieceCount")}</label>
          <select
            id={`${formId}-count`}
            value={pieceCount}
            disabled={countLocked}
            onChange={(e) => setPieceCount(Number(e.target.value))}
          >
            {PIECE_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {countLocked && <p className="muted">{t("countLocked")}</p>}
          <label htmlFor={`${formId}-start`}>{t("startsAt")}</label>
          <input
            id={`${formId}-start`}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
          <label htmlFor={`${formId}-end`}>{t("endsAt")}</label>
          <input
            id={`${formId}-end`}
            type="datetime-local"
            value={endsAt}
            min={startsAt || undefined}
            onChange={(e) => setEndsAt(e.target.value)}
          />
          <p className="muted">{t("windowHint")}</p>
          {error && <p className="error">{error}</p>}
          <div className="card-actions">
            <button className="button" type="submit" disabled={busy}>
              {competition ? t("save") : t("start")}
            </button>
            {competition && (
              <button className="button danger" type="button" disabled={busy} onClick={end}>
                {t("end")}
              </button>
            )}
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {!isPublic && !competition && <p className="muted">{t("needsPublic")}</p>}
    </div>
  );
}
