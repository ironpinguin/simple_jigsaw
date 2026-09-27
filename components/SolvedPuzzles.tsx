"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import BestTimesList, { type BestTimeRow } from "./BestTimesList";

export interface SolvedPuzzle {
  id: string;
  title: string;
  imageKey: string;
  bests: BestTimeRow[];
}

/**
 * Other people's puzzles the signed-in solver has a best time on (#127) — the
 * own ones show theirs in their card above. Only public puzzles: one made
 * private since cannot be opened any more, so it is left out rather than
 * linked to a 404.
 */
export default function SolvedPuzzles({ puzzles }: { puzzles: readonly SolvedPuzzle[] }) {
  const t = useTranslations("my");
  if (puzzles.length === 0) return null;
  return (
    <section style={{ marginTop: 32 }}>
      <h2>{t("solvedTitle")}</h2>
      <p className="muted">{t("solvedIntro")}</p>
      <div className="grid-cards">
        {puzzles.map((p) => (
          <div key={p.id} className="card puzzle-card">
            <Link href={`/puzzle/${p.id}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/image/${p.imageKey}`} alt={p.title} />
            </Link>
            <h3>{p.title}</h3>
            <BestTimesList bests={p.bests} />
            <div className="card-actions">
              <Link href={`/puzzle/${p.id}`} className="button">
                {t("solveAgain")}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
