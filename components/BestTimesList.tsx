"use client";

import { useTranslations } from "next-intl";
import { Timer } from "lucide-react";
import { formatDuration } from "@/lib/puzzle/timer";
import type { BestTimeRow } from "@/lib/best-times";

export type { BestTimeRow };

/**
 * The signed-in solver's best times on one puzzle (#127), one per piece count,
 * smallest count first. Renders nothing without any.
 */
export default function BestTimesList({ bests }: { bests: readonly BestTimeRow[] }) {
  const t = useTranslations("my");
  if (bests.length === 0) return null;
  const sorted = [...bests].sort((a, b) => a.pieceCount - b.pieceCount);
  return (
    <div className="best-times">
      <p className="muted" style={{ margin: 0 }}>
        <Timer size={14} aria-hidden="true" /> {t("bestTimes")}
      </p>
      <ul>
        {sorted.map((b) => (
          <li key={b.pieceCount}>
            {t("bestTime", {
              count: b.pieceCount,
              time: formatDuration(b.ms),
              moves: b.moves,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
