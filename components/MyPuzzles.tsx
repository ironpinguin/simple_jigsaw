"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { tryFetch } from "@/lib/try-fetch";
import CompetitionSettings, { type OwnerCompetition } from "./CompetitionSettings";
import BestTimesList, { type BestTimeRow } from "./BestTimesList";
import BoardBackgroundPicker from "./BoardBackgroundPicker";
import PieceDefaultsPicker from "./PieceDefaultsPicker";
import { isBoardBackground, type BoardBackground } from "@/lib/puzzle/background";
import { isPieceStyle, type PieceStyle } from "@/lib/puzzle/style";

interface PuzzleSummary {
  id: string;
  title: string;
  imageKey: string;
  pieceCount: number;
  /** The default piece shape (#150). */
  pieceStyle: PieceStyle;
  isPublic: boolean;
  /** The default table colour solvers see (#147). */
  boardBackground: BoardBackground;
  competition: OwnerCompetition | null;
  /** The owner's own best times on it (#127). */
  bests: BestTimeRow[];
}

type CardSettings = Pick<PuzzleSummary, "boardBackground" | "pieceCount" | "pieceStyle">;
/** One setting per PATCH, as the API takes them. */
type CardSetting =
  | Pick<CardSettings, "boardBackground">
  | Pick<CardSettings, "pieceCount">
  | Pick<CardSettings, "pieceStyle">;

export default function MyPuzzles({ initial }: { initial: PuzzleSummary[] }) {
  const t = useTranslations("my");
  const tBg = useTranslations("boardBackground");
  const router = useRouter();
  const [puzzles, setPuzzles] = useState(initial);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Per card: finishing one card's request must not re-enable another card
  // whose request is still running.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  function setBusy(id: string, busy: boolean) {
    setBusyIds((ids) => {
      const next = new Set(ids);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function share(id: string) {
    const url = `${window.location.origin}/puzzle/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function remove(id: string) {
    if (!confirm(t("confirmDelete"))) return;
    setBusy(id, true);
    try {
      const res = await tryFetch("my", `/api/puzzles/${id}`, { method: "DELETE" });
      if (!res) {
        alert(t("deleteFailed"));
      } else if (res.ok) {
        setPuzzles((list) => list.filter((p) => p.id !== id));
      } else if (res.status === 401) {
        router.push("/login?callbackUrl=/my");
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? t("deleteFailed"));
      }
    } finally {
      setBusy(id, false);
    }
  }

  async function toggleVisibility(id: string, isPublic: boolean) {
    setBusy(id, true);
    try {
      const res = await tryFetch("my", `/api/puzzles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic }),
      });
      if (!res) {
        alert(t("visibilityFailed"));
      } else if (res.ok) {
        // The badge reflects what the server confirmed; a 200 without the
        // expected shape is an API contract break — log it, then fall back to
        // the requested state as the best available guess.
        const data = await res.json().catch(() => null);
        const confirmed: unknown = data?.puzzle?.isPublic;
        if (typeof confirmed !== "boolean") {
          console.error("[my] PATCH answered 200 without puzzle.isPublic:", data);
        }
        const next = typeof confirmed === "boolean" ? confirmed : isPublic;
        // Making a puzzle private rotates its imageKey server-side; without
        // the new key the thumbnail keeps pointing at the rotated-away (404)
        // one until a reload.
        const newKey: unknown = data?.puzzle?.imageKey;
        setPuzzles((list) =>
          list.map((p) =>
            p.id === id
              ? { ...p, isPublic: next, ...(typeof newKey === "string" ? { imageKey: newKey } : {}) }
              : p,
          ),
        );
      } else if (res.status === 401) {
        router.push("/login?callbackUrl=/my");
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? t("visibilityFailed"));
      }
    } finally {
      setBusy(id, false);
    }
  }

  /**
   * One PATCH for a single card setting — the board background, the piece
   * count or the style. What the server confirms is merged in, what was asked
   * stands in for anything it left out.
   */
  async function patchPuzzle(id: string, body: CardSetting, failed: string) {
    setBusy(id, true);
    try {
      const res = await tryFetch("my", `/api/puzzles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res) {
        alert(failed);
      } else if (res.ok) {
        const data = await res.json().catch(() => null);
        const confirmed = { ...body, ...pickSettings(data?.puzzle) };
        setPuzzles((list) => list.map((p) => (p.id === id ? { ...p, ...confirmed } : p)));
      } else if (res.status === 401) {
        router.push("/login?callbackUrl=/my");
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? failed);
      }
    } finally {
      setBusy(id, false);
    }
  }

  function changePieceCount(id: string, pieceCount: number) {
    // A new count is a new grid: solves stored for the old one no longer fit
    // and are dropped. A new style keeps the grid, so it needs no warning.
    if (!confirm(t("confirmPieceCount"))) return;
    void patchPuzzle(id, { pieceCount }, t("piecesFailed"));
  }

  function setCompetition(id: string, competition: OwnerCompetition | null) {
    setPuzzles((list) => list.map((p) => (p.id === id ? { ...p, competition } : p)));
  }

  return (
    <div className="grid-cards">
      {puzzles.map((p) => (
        <div key={p.id} className="card puzzle-card">
          <Link href={`/puzzle/${p.id}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/image/${p.imageKey}`} alt={p.title} />
          </Link>
          <h3>{p.title}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {t("pieces", { count: p.pieceCount })} · {p.isPublic ? t("public") : t("private")}
          </p>
          <BestTimesList bests={p.bests} />
          <div style={{ margin: "10px 0" }}>
            <span className="muted">{tBg("label")}</span>
            <BoardBackgroundPicker
              value={p.boardBackground}
              disabled={busyIds.has(p.id)}
              onChange={(bg) => {
                if (bg !== p.boardBackground) {
                  void patchPuzzle(p.id, { boardBackground: bg }, t("backgroundFailed"));
                }
              }}
            />
          </div>
          <PieceDefaultsPicker
            pieceCount={p.pieceCount}
            pieceStyle={p.pieceStyle}
            disabled={busyIds.has(p.id)}
            locked={piecesLocked(p.competition)}
            onCountChange={(n) => changePieceCount(p.id, n)}
            onStyleChange={(s) => void patchPuzzle(p.id, { pieceStyle: s }, t("styleFailed"))}
          />
          <div className="card-actions">
            <Link href={`/puzzle/${p.id}`} className="button">
              {t("solve")}
            </Link>
            <button className="button secondary" type="button" onClick={() => share(p.id)}>
              {copiedId === p.id ? t("copied") : t("share")}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busyIds.has(p.id)}
              onClick={() => toggleVisibility(p.id, !p.isPublic)}
            >
              {p.isPublic ? t("makePrivate") : t("makePublic")}
            </button>
            <button
              className="button danger"
              type="button"
              disabled={busyIds.has(p.id)}
              onClick={() => remove(p.id)}
            >
              {t("delete")}
            </button>
          </div>
          <CompetitionSettings
            puzzleId={p.id}
            isPublic={p.isPublic}
            defaultPieceCount={p.pieceCount}
            initial={p.competition}
            onChange={(c) => setCompetition(p.id, c)}
          />
        </div>
      ))}
    </div>
  );
}

/** A competition, ended or not, fixes the piece defaults — as the API enforces. */
function piecesLocked(c: OwnerCompetition | null): boolean {
  return c !== null;
}

/** The card settings a PATCH answer carries, where they have the expected shape. */
function pickSettings(puzzle: unknown): Partial<CardSettings> {
  if (!puzzle || typeof puzzle !== "object") return {};
  const { boardBackground, pieceCount, pieceStyle } = puzzle as Record<string, unknown>;
  return {
    ...(isBoardBackground(boardBackground) ? { boardBackground } : {}),
    ...(typeof pieceCount === "number" ? { pieceCount } : {}),
    ...(isPieceStyle(pieceStyle) ? { pieceStyle } : {}),
  };
}
