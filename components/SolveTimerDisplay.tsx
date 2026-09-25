"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Timer } from "lucide-react";
import { formatDuration, readClock, type SolveResult } from "@/lib/puzzle/timer";
import type { SolveTimer } from "./solveTimer";

/** Often enough that a second never visibly lingers; see `SolveTimer` for why only this ticks. */
const TICK_MS = 500;

/**
 * The running solve time in the toolbar. `role="timer"` is a live region that is
 * off by default, so a screen reader reads the time on demand instead of every
 * second.
 */
export default function SolveTimerDisplay({
  timer,
  best,
}: {
  timer: SolveTimer;
  /** The best result for the current piece count, if there is one. */
  best: SolveResult | null;
}) {
  const t = useTranslations("solve");
  const { clock } = useSyncExternalStore(timer.subscribe, timer.get, timer.get);
  const running = clock.runningSince !== null;

  // Only ever set from the interval. Until its first tick `now` is older than the
  // run, which `readClock` reads as the banked time — so no clock is read during
  // a render, and the server and the first client render agree.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [running]);

  const bestText = best ? t("bestTime", { time: formatDuration(best.ms) }) : null;

  return (
    <span className="solve-timer" role="timer" title={bestText ?? t("time")}>
      <Timer size={16} aria-hidden="true" />
      <span className="sr-only">{t("time")}</span>
      {formatDuration(readClock(clock, now))}
      {bestText && <span className="sr-only">, {bestText}</span>}
    </span>
  );
}
