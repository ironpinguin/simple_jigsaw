"use client";

import { useId, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Download, Trophy } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { tryFetch } from "@/lib/try-fetch";
import { PIECE_PRESETS } from "@/lib/puzzle/grid";
import { COMPETITION_DATE_FORMAT, competitionPhaseOfIso } from "@/lib/competition";
import { fromLocalInput, toLocalInput } from "@/lib/local-datetime";
import Leaderboard from "./Leaderboard";

export interface OwnerCompetition {
  pieceCount: number;
  startsAt: string | null;
  endsAt: string | null;
  entries: number;
}

/**
 * The owner's side of a competition (#119), inside a puzzle's card on /my:
 * a summary line, the leaderboard with its CSV download (#139), and a form to
 * start, change, end or delete it.
 */
export default function CompetitionSettings({
  puzzleId,
  isPublic,
  defaultPieceCount,
  initial,
  onChange,
}: {
  puzzleId: string;
  isPublic: boolean;
  /** Offered for a new competition: the puzzle's current default count. */
  defaultPieceCount: number;
  initial: OwnerCompetition | null;
  /** Told of every saved change, so the card can lock what a competition fixes. */
  onChange?: (competition: OwnerCompetition | null) => void;
}) {
  const t = useTranslations("competition");
  const format = useFormatter();
  const router = useRouter();
  const formId = useId();
  const [competition, setCompetitionState] = useState(initial);
  function setCompetition(next: OwnerCompetition | null) {
    setCompetitionState(next);
    onChange?.(next);
  }
  const [open, setOpen] = useState(false);
  const [pieceCount, setPieceCount] = useState(initial?.pieceCount ?? defaultPieceCount);
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial?.endsAt ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  /** Bumped after ending, so an open leaderboard shows the final state. */
  const [boardVersion, setBoardVersion] = useState(0);

  const when = (iso: string) => format.dateTime(new Date(iso), COMPETITION_DATE_FORMAT);

  // The phase is read from the clock at render; a card left open across the
  // start or end date shows the old phase until the page is reloaded.
  const phaseOf = (c: OwnerCompetition) => competitionPhaseOfIso(c, new Date());

  function summary(c: OwnerCompetition): string {
    const phase = phaseOf(c);
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

  /** Close it now and keep the result — see the `end` route. */
  async function end() {
    if (!confirm(t("confirmEnd"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tryFetch("competition", `/api/puzzles/${puzzleId}/competition/end`, {
        method: "POST",
      });
      if (!res?.ok) return fail(res, t("endFailed"));
      const data = await res.json().catch(() => null);
      const ended = data?.competition;
      if (!ended || typeof ended.pieceCount !== "number") {
        console.error("[competition] end answered 200 without a competition:", data);
        return setError(t("endFailed"));
      }
      setCompetition({ ...ended, entries: competition?.entries ?? 0 });
      setEndsAt(toLocalInput(ended.endsAt));
      setStartsAt(toLocalInput(ended.startsAt));
      setBoardVersion((v) => v + 1);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  /** Remove the competition and its leaderboard for good. */
  async function remove() {
    if (!confirm(t("confirmDelete"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tryFetch("competition", `/api/puzzles/${puzzleId}/competition`, {
        method: "DELETE",
      });
      if (!res?.ok) return fail(res, t("deleteFailed"));
      setCompetition(null);
      setShowBoard(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  // The piece count cannot change under entries — the API refuses it, and the
  // form says so instead of offering it.
  const countLocked = (competition?.entries ?? 0) > 0;
  const closed = competition !== null && phaseOf(competition) === "CLOSED";

  return (
    <div className="competition-settings">
      {competition && (
        <p className="muted" style={{ margin: 0 }}>
          <Trophy size={14} aria-hidden="true" /> {summary(competition)}
        </p>
      )}
      {competition && (
        <div className="card-actions">
          <button
            className="button secondary"
            type="button"
            aria-expanded={showBoard}
            onClick={() => setShowBoard((v) => !v)}
          >
            {showBoard ? t("hideLeaderboard") : t("showLeaderboard")}
          </button>
          {/* A plain link: the browser sends the session cookie and saves the
              file under the name the route gives it. */}
          <a
            className="button secondary"
            href={`/api/puzzles/${puzzleId}/competition/leaderboard`}
            download
          >
            <Download size={14} aria-hidden="true" /> {t("downloadCsv")}
          </a>
        </div>
      )}
      {competition && showBoard && (
        <Leaderboard
          puzzleId={puzzleId}
          active={showBoard}
          version={boardVersion}
          signedIn
          isAdmin={false}
        />
      )}
      {!open ? (
        // A competition that exists stays reachable after the puzzle went
        // private — ending it is the one thing its owner may still want.
        <button
          className="button secondary"
          type="button"
          disabled={!isPublic && !competition}
          title={isPublic || competition ? undefined : t("needsPublic")}
          onClick={() => {
            // The default can change on the card after mount (#150), so a new
            // competition reads it when the form opens, not when it mounted.
            if (!competition) setPieceCount(defaultPieceCount);
            setOpen(true);
          }}
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
          <p className="muted">{closed ? t("endedHint") : t("windowHint")}</p>
          {error && <p className="error">{error}</p>}
          <div className="card-actions">
            <button className="button" type="submit" disabled={busy}>
              {competition ? t("save") : t("start")}
            </button>
            {competition && !closed && (
              <button className="button danger" type="button" disabled={busy} onClick={end}>
                {t("end")}
              </button>
            )}
            {competition && (
              <button className="button danger" type="button" disabled={busy} onClick={remove}>
                {t("delete")}
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
