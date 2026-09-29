"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { tryFetch } from "@/lib/try-fetch";
import CompetitionSettings, { type OwnerCompetition } from "./CompetitionSettings";
import BestTimesList, { type BestTimeRow } from "./BestTimesList";
import BoardBackgroundPicker from "./BoardBackgroundPicker";
import { toBoardBackground, type BoardBackground } from "@/lib/puzzle/background";

interface PuzzleSummary {
  id: string;
  title: string;
  imageKey: string;
  pieceCount: number;
  isPublic: boolean;
  /** The default table colour solvers see (#147). */
  boardBackground: BoardBackground;
  competition: OwnerCompetition | null;
  /** The owner's own best times on it (#127). */
  bests: BestTimeRow[];
}

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

  async function changeBackground(id: string, boardBackground: BoardBackground) {
    setBusy(id, true);
    try {
      const res = await tryFetch("my", `/api/puzzles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardBackground }),
      });
      if (!res) {
        alert(t("backgroundFailed"));
      } else if (res.ok) {
        // As with visibility: what the server confirmed, else what was asked.
        const data = await res.json().catch(() => null);
        const confirmed = toBoardBackground(data?.puzzle?.boardBackground ?? boardBackground);
        setPuzzles((list) =>
          list.map((p) => (p.id === id ? { ...p, boardBackground: confirmed } : p)),
        );
      } else if (res.status === 401) {
        router.push("/login?callbackUrl=/my");
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? t("backgroundFailed"));
      }
    } finally {
      setBusy(id, false);
    }
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
                if (bg !== p.boardBackground) void changeBackground(p.id, bg);
              }}
            />
          </div>
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
          />
        </div>
      ))}
    </div>
  );
}
