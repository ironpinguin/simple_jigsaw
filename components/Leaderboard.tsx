"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { UserX, X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { tryFetch } from "@/lib/try-fetch";
import { formatDuration } from "@/lib/puzzle/timer";
import { COMPETITION_DATE_FORMAT, type CompetitionPhase } from "@/lib/competition";
import type { Leaderboard as LeaderboardData } from "@/lib/competition-server";

interface Loaded extends LeaderboardData {
  competition: {
    pieceCount: number;
    startsAt: string | null;
    endsAt: string | null;
    phase: CompetitionPhase;
  };
}

/**
 * A puzzle's competition leaderboard (#119), inside the solve toolbar's trophy
 * popover. Loaded when first shown and again whenever `version` changes — the
 * solver bumps it after an entry lands — rather than on page load: most visits
 * never open it.
 */
export default function Leaderboard({
  puzzleId,
  active,
  version,
  signedIn,
  isAdmin,
}: {
  puzzleId: string;
  /** Whether the popover is open. */
  active: boolean;
  version: number;
  signedIn: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations("competition");
  const format = useFormatter();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // What the loaded board is current for: the solver's entries and this
  // component's own removals both call for a fresh one.
  const key = `${version}:${reload}`;
  useEffect(() => {
    if (!active || loadedFor === key) return;
    let cancelled = false;
    (async () => {
      const res = await tryFetch("competition", `/api/competitions/${puzzleId}`);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      if (cancelled) return;
      if (body && Array.isArray(body.entries)) {
        setData(body);
        setFailed(false);
        setLoadedFor(key);
      } else {
        // Not marked as loaded, so opening the popover again tries once more.
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, key, loadedFor, puzzleId]);

  /** `resetName` for an entry removed because of its name — see the admin route. */
  async function remove(id: string, name: string, resetName = false) {
    const question = resetName ? "confirmRemoveEntryAndName" : "confirmRemoveEntry";
    if (!confirm(t(question, { name }))) return;
    setRemoving(id);
    try {
      const url = `/api/admin/leaderboard/${id}${resetName ? "?resetName=1" : ""}`;
      const res = await tryFetch("competition", url, { method: "DELETE" });
      if (!res?.ok) {
        const body = res ? await res.json().catch(() => null) : null;
        alert(body?.error ?? t("removeEntryFailed"));
      }
      setReload((n) => n + 1);
    } finally {
      setRemoving(null);
    }
  }

  const when = (iso: string) => format.dateTime(new Date(iso), COMPETITION_DATE_FORMAT);

  if (failed) return <p className="muted">{t("leaderboardFailed")}</p>;
  if (!data) return <p className="muted">{t("leaderboardLoading")}</p>;

  const { competition, entries, you } = data;
  const status =
    competition.phase === "UPCOMING"
      ? t("startsOn", { date: when(competition.startsAt!) })
      : competition.phase === "CLOSED"
        ? t("endedOn", { date: when(competition.endsAt!) })
        : competition.endsAt
          ? t("runsUntil", { date: when(competition.endsAt) })
          : t("running");

  return (
    <div className="leaderboard">
      <h2 className="leaderboard-title">{t("leaderboard")}</h2>
      <p className="muted">
        {status} · {t("fixedPieces", { count: competition.pieceCount })}
      </p>
      {entries.length === 0 ? (
        <p className="muted">{t("noEntries")}</p>
      ) : (
        <ol className="leaderboard-list">
          {entries.map((e) => (
            <li key={e.id} className={e.isYou ? "is-you" : undefined}>
              <span className="leaderboard-rank">{e.rank}.</span>
              <span className="leaderboard-name">
                {e.displayName}
                {e.isYou && <span className="muted"> ({t("you")})</span>}
              </span>
              <span className="leaderboard-time">{formatDuration(e.ms)}</span>
              <span className="muted leaderboard-moves">{t("moves", { count: e.moves })}</span>
              {isAdmin && (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("removeEntry", { name: e.displayName })}
                    title={t("removeEntry", { name: e.displayName })}
                    disabled={removing === e.id}
                    onClick={() => remove(e.id, e.displayName)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("removeEntryAndName", { name: e.displayName })}
                    title={t("removeEntryAndName", { name: e.displayName })}
                    disabled={removing === e.id}
                    onClick={() => remove(e.id, e.displayName, true)}
                  >
                    <UserX size={16} aria-hidden="true" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {you && !entries.some((e) => e.isYou) && (
        <p>{t("yourRank", { rank: you.rank, time: formatDuration(you.ms) })}</p>
      )}
      {!signedIn && competition.phase !== "CLOSED" && (
        <p className="muted">
          {t.rich("signInToTakePart", {
            login: (chunks) => <Link href={`/login?callbackUrl=/puzzle/${puzzleId}`}>{chunks}</Link>,
          })}
        </p>
      )}
    </div>
  );
}
