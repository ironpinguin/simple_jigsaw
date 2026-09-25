"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  CircleHelp,
  Ellipsis,
  Flag,
  ImageIcon,
  LinkIcon,
  Magnet,
  MapIcon,
  PartyPopper,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { BoardActions, PuzzleData } from "./PuzzleBoard";
import ReportDialog from "@/components/ReportDialog";
import ToolbarPopover from "./ToolbarPopover";
import SolveTimerDisplay from "./SolveTimerDisplay";
import { createSolveTimer } from "./solveTimer";
import { celebrate, stopCelebration } from "./celebrate";
import { computeGrid, PIECE_PRESETS } from "@/lib/puzzle/grid";
import {
  MAX_STORED_SOLVES,
  SOLVE_KEY_PREFIX,
  solveKeysToPrune,
  solveStateKey,
  type SolveTiming,
} from "@/lib/puzzle/solveState";
import {
  bestTimesKey,
  formatDuration,
  parseBestTimes,
  recordBestTime,
  type SolveResult,
} from "@/lib/puzzle/timer";

function BoardLoading() {
  const t = useTranslations("solve");
  return <p className="muted">{t("loading")}</p>;
}

const PuzzleBoard = dynamic(() => import("./PuzzleBoard"), {
  ssr: false,
  loading: () => <BoardLoading />,
});

/**
 * Run `fn` against localStorage, falling back to `whenUnavailable` if storage
 * cannot be used at all.
 *
 * Reaching for `window.localStorage` is itself throwing code: browsers raise
 * `SecurityError` from the *getter* when site data is blocked by policy or the
 * page is a sandboxed iframe. So it is not enough to guard the individual
 * `setItem` — every touch has to go through here, including the reads, which run
 * from effects where an escaping error unwinds past the board (this app has no
 * error boundary) and replaces the puzzle with Next's error page.
 */
function withStorage<T>(fn: (store: Storage) => T, whenUnavailable: T): T {
  try {
    return fn(window.localStorage);
  } catch (err) {
    // Covers both shapes of failure, since neither is recoverable here and the
    // error itself names which one it was: `SecurityError` from the getter, and
    // `QuotaExceededError` from a write against a full origin.
    console.warn("[solve] localStorage unavailable or full; progress is not saved", err);
    return whenUnavailable;
  }
}

/**
 * Whether the solver muted the applause, for every puzzle. Outside the `solve:`
 * prefix on purpose: `storedSolves` treats every key under it as a solve state.
 */
const SOUND_KEY = "celebration:sound";

/** Every stored solve state, so `saveSolveState` can prune the least recent. */
function storedSolves(store: Storage): Array<{ key: string; raw: string | null }> {
  const entries: Array<{ key: string; raw: string | null }> = [];
  // Enumerate fully before deleting anything: removing inside this loop would
  // shift the indices and skip every other key.
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(SOLVE_KEY_PREFIX)) {
      entries.push({ key, raw: store.getItem(key) });
    }
  }
  return entries;
}

/**
 * The toolbar draws SVG icons rather than emoji: an emoji is only as good as the
 * system's font, and one without 🧲 or 🔗 (Unicode 11 and older fonts) shows an
 * empty box in its place.
 */
const ICON_SIZE = 18;

interface ToggleItem {
  icon: ReactNode;
  label: string;
  title: string;
  pressed?: boolean;
  onClick: () => void;
}

/** The toolbar's solving toggles: icons in the bar, labelled rows in the menu. */
function ToggleButtons({ items, inMenu = false }: { items: ToggleItem[]; inMenu?: boolean }) {
  return items.map(({ icon, label, title, pressed, onClick }) => (
    <button
      key={label}
      type="button"
      className={`${inMenu ? "menu-item" : "icon-button"} ${pressed ? "active" : ""}`}
      // A stable name with the state in aria-pressed: a toggle whose name flips
      // with its state is announced as the opposite of what it does.
      aria-label={inMenu ? undefined : label}
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      {inMenu && ` ${label}`}
    </button>
  ));
}

export default function PuzzleSolver({
  puzzle,
  title,
  isPublic,
}: {
  puzzle: PuzzleData;
  title: string;
  /** Only public puzzles can be reported — /api/report answers 404 otherwise. */
  isPublic: boolean;
}) {
  const t = useTranslations("solve");
  const tReport = useTranslations("report");
  const storageKey = `pc:${puzzle.id}`;
  const solveKey = solveStateKey(puzzle.id);

  // Piece count is per solver: default to the creator's value, but remember the
  // solver's own choice for this puzzle. The stored value is only applied after
  // mount — reading it during render would make the first client render differ
  // from the server's and break hydration. The cost is that a remembered count
  // builds the board twice, so keep the read in the effect below.
  const [pieceCount, setPieceCount] = useState(puzzle.pieceCount);

  useEffect(() => {
    const saved = Number(withStorage((s) => s.getItem(storageKey), null));
    // react-hooks/set-state-in-effect wants this read during render instead
    // (#84) — which is exactly what the comment above says must not happen, and
    // what "hydrates without a mismatch when a piece count was remembered" in
    // the test file fails on: moving the read into the useState initialiser
    // makes the first client render disagree with the server's.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- would break hydration; see above
    if ((PIECE_PRESETS as readonly number[]).includes(saved)) setPieceCount(saved);
  }, [storageKey]);

  const { cols, rows } = useMemo(
    () => computeGrid(pieceCount, puzzle.imageWidth / puzzle.imageHeight),
    [pieceCount, puzzle.imageWidth, puzzle.imageHeight],
  );
  const total = cols * rows;

  // The board reports which grid its group count belongs to. Keeping that with
  // the count lets a report from the previous grid be ignored: after a
  // piece-count change the board rebuilds asynchronously (its chunk and the
  // image have to load first), and counting against the new `total` in the
  // meantime would show a negative number of connections.
  const [progress, setProgress] = useState<{ groups: number; total: number } | null>(null);
  const [solved, setSolved] = useState(false);
  const [showRef, setShowRef] = useState(true);
  const [showMap, setShowMap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // On by default (issue #117); applied after mount like the piece count, for
  // the same hydration reason.
  const [sound, setSound] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- would break hydration; see the piece count
    if (withStorage((s) => s.getItem(SOUND_KEY), null) === "off") setSound(false);
  }, []);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    withStorage((s) => s.setItem(SOUND_KEY, next ? "on" : "off"), undefined);
  }

  // --- The solve timer (#118) ------------------------------------------------

  const [timer] = useState(createSolveTimer);
  /** What the board last reported, for `onSeeded` — which it calls right after. */
  const solvedRef = useRef(false);
  const bestKey = bestTimesKey(puzzle.id);

  /** The best result for the current piece count; read after mount, like `pc:`. */
  const [best, setBest] = useState<SolveResult | null>(null);
  useEffect(() => {
    const stored = parseBestTimes(withStorage((s) => s.getItem(bestKey), null));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- would break hydration; see the piece count
    setBest(stored[pieceCount] ?? null);
  }, [bestKey, pieceCount]);

  /** The card shown after the drop that finishes the puzzle. */
  const [result, setResult] = useState<{
    outcome: SolveResult;
    /** The best this one beat, or `null` for a first solve or no new best. */
    beaten: SolveResult | null;
    best: SolveResult;
    isNew: boolean;
  } | null>(null);

  const onProgress = useCallback((groups: number, boardTotal: number) => {
    setProgress({ groups, total: boardTotal });
    setSolved(groups === 1);
    solvedRef.current = groups === 1;
  }, []);

  // All four are stable, which the board needs of `onSeeded` (a dependency of its
  // seeding effect) and `readTiming` (of its save).
  const onSeeded = useCallback(
    (timing: SolveTiming | null) => timer.reset(timing, solvedRef.current),
    [timer],
  );
  const readTiming = useCallback(() => timer.timing(Date.now()), [timer]);
  const onPieceGrab = useCallback(
    () => timer.grab(Date.now(), document.visibilityState !== "hidden"),
    [timer],
  );
  const onPieceDrop = useCallback(() => timer.drop(), [timer]);

  // Hiding the tab pauses the clock — and saves, since the time since the last
  // drop exists nowhere else. Browsers also hide the page on a reload or when it
  // is closed, which is what makes the time survive those.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        if (timer.hide(Date.now())) boardActions.current?.save();
      } else {
        timer.show(Date.now());
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [timer]);

  // The celebration hangs off this, not off `solved`: `onProgress` also marks a
  // puzzle solved when a finished one is restored, and a reload must not replay it.
  const onSolved = useCallback(() => {
    setSolved(true);
    const outcome = timer.finish(Date.now());
    // The board saved just before calling this, with the clock still running;
    // saving again stores the time the solve is shown with.
    boardActions.current?.save();
    const recorded = recordBestTime(
      withStorage((s) => s.getItem(bestKey), null),
      pieceCount,
      outcome,
    );
    withStorage((s) => s.setItem(bestKey, recorded.raw), undefined);
    setBest(recorded.best);
    setResult({
      outcome,
      beaten: recorded.isNew ? recorded.previous : null,
      best: recorded.best,
      isNew: recorded.isNew,
    });
    celebrate({ sound });
  }, [sound, timer, bestKey, pieceCount]);

  useEffect(() => stopCelebration, []);

  // --- The solve state -------------------------------------------------------
  //
  // Where the pieces lie and which of them are joined, kept in the browser only
  // (issue #12) — it deliberately does not follow the solver to another device.
  // The board does the (de)serialising, since it owns the group model and the
  // stage the positions are relative to; every localStorage call lives here, as
  // the `pc:` one above already does.

  const [resetNonce, setResetNonce] = useState(0);

  /** Filled by the board once its chunk has loaded; see `BoardActions`. */
  const boardActions = useRef<BoardActions | null>(null);

  /**
   * Read by the board from its seeding effect, never during a render — this
   * component *does* render on the server, where there is no storage at all
   * (`PuzzleSolver.test.tsx` hides the globals to keep that honest).
   *
   * Must stay referentially stable: the board lists it in that effect's
   * dependencies, so an inline arrow here would re-seed the board from storage on
   * every parent render — every toolbar toggle would re-assign group ids.
   */
  const loadSolveState = useCallback(
    () => withStorage((s) => s.getItem(solveKey), null),
    [solveKey],
  );

  const saveSolveState = useCallback(
    (raw: string) => {
      withStorage((store) => {
        // Opening puzzle after puzzle would otherwise grow the origin's storage
        // without bound, so retire the least recently played solves first. This is
        // a retention policy rather than a way of making room for this one write:
        // the entries it drops are already past the cap.
        for (const key of solveKeysToPrune(storedSolves(store), solveKey, MAX_STORED_SOLVES)) {
          store.removeItem(key);
        }
        // A full origin throws here, and `withStorage` is what swallows it. That
        // matters most on this path: the board calls this from a Konva `dragend`
        // handler, so an escaping error would not unmount anything — it would
        // surface as an uncaught error out of Konva's event dispatch, once per
        // drop, where no React error boundary can reach it.
        store.setItem(solveKey, raw);
      }, undefined);
    },
    [solveKey],
  );

  function clearSolveState() {
    withStorage((s) => s.removeItem(solveKey), undefined);
  }

  /**
   * Whether there is a saved solve to lose. `connected` cannot answer that: it
   * comes from the board's in-memory report, which is 0 until the board has built
   * — its chunk, the image and the container width all have to resolve first — so
   * for the first moments of every visit a fully joined board reads as untouched.
   */
  function hasStoredSolve() {
    return withStorage((s) => s.getItem(solveKey) !== null, false);
  }

  function startOver() {
    if (!window.confirm(t("confirmReset"))) return;
    clearSolveState();
    // The board re-seeds from its scatter when this changes. That scatter is
    // derived from the puzzle's seed, so starting over gives back the same
    // relative arrangement the link has always had rather than a new random one.
    setResetNonce((n) => n + 1);
    // The board reports again once it has re-seeded; until then say nothing is
    // connected instead of leaving the old count — and the solved banner up.
    setProgress(null);
    setSolved(false);
    setResult(null);
    stopCelebration();
  }

  // Connections made; total-1 when solved. An unbuilt or just-resized board has
  // not reported for this grid yet, and then nothing is connected.
  const connected = progress?.total === total ? total - progress.groups : 0;

  function changeCount(n: number) {
    if (n === pieceCount) return;
    // Warn if there is progress to lose — either connected on the board in front
    // of the solver, or saved from an earlier visit. Asking about the saved state
    // too is what keeps the prompt honest now that the rebuild deletes something
    // durable: a board still loading reports nothing connected, and gating on that
    // alone would throw a finished puzzle away without a word.
    if ((connected > 0 || hasStoredSolve()) && !window.confirm(t("confirmChange"))) {
      return;
    }
    setPieceCount(n);
    setResult(null);
    withStorage((s) => s.setItem(storageKey, String(n)), undefined);
    // The new grid could not restore it anyway — `deserialiseSolveState` rejects a
    // cols/rows mismatch — but deleting it here is what the warning promises.
    clearSolveState();
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function gather() {
    boardActions.current?.gatherLoose();
  }

  function closeMenu() {
    setMenuOpen(false);
    moreRef.current?.focus();
  }

  // Shown in the bar and — on a narrow screen, where the bar keeps only the
  // title, progress and the two popovers — in the overflow menu as well.
  const toggles: ToggleItem[] = [
    {
      icon: <ImageIcon size={ICON_SIZE} />,
      label: t("preview"),
      title: showRef ? t("hideRef") : t("showRef"),
      pressed: showRef,
      onClick: () => setShowRef((v) => !v),
    },
    {
      icon: <MapIcon size={ICON_SIZE} />,
      label: t("overview"),
      title: showMap ? t("hideMap") : t("showMap"),
      pressed: showMap,
      onClick: () => setShowMap((v) => !v),
    },
    { icon: <Magnet size={ICON_SIZE} />, label: t("gather"), title: t("gather"), onClick: gather },
    {
      icon: sound ? <Volume2 size={ICON_SIZE} /> : <VolumeX size={ICON_SIZE} />,
      label: t("sound"),
      title: t("sound"),
      pressed: sound,
      onClick: toggleSound,
    },
  ];

  return (
    <div>
      <div className="solve-toolbar">
        <h1 className="solve-title" title={title}>
          {title}
        </h1>
        <span className="progress">
          {t("progress", { connected, total: total - 1 })}
        </span>
        <SolveTimerDisplay timer={timer} best={best} />
        {solved && (
          <span className="solved-banner">
            <PartyPopper size={16} aria-hidden="true" /> {t("solved")}
          </span>
        )}

        <div className="solve-actions">
          <div className="solve-toggles">
            <ToggleButtons items={toggles} />
          </div>

          <ToolbarPopover icon={<CircleHelp size={ICON_SIZE} />} label={t("help")} className="solve-help">
            <p style={{ margin: 0 }}>{t("instructions")}</p>
          </ToolbarPopover>

          <ToolbarPopover
            icon={<Ellipsis size={ICON_SIZE} />}
            label={t("more")}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerRef={moreRef}
          >
            <div className="solve-menu-toggles">
              <ToggleButtons items={toggles} inMenu />
            </div>
            <label className="menu-item">
              {t("pieces")}
              <select
                id="piece-count"
                name="pieceCount"
                value={pieceCount}
                onChange={(e) => changeCount(Number(e.target.value))}
                style={{ width: "auto", marginLeft: "auto" }}
              >
                {PIECE_PRESETS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {/* Stays open so the "copied" confirmation can be seen. */}
            <button className="menu-item" type="button" onClick={share}>
              <LinkIcon size={ICON_SIZE} aria-hidden="true" /> {copied ? t("copied") : t("share")}
            </button>
            <button
              className="menu-item"
              type="button"
              onClick={() => {
                closeMenu();
                startOver();
              }}
            >
              <RotateCcw size={ICON_SIZE} aria-hidden="true" /> {t("reset")}
            </button>
            {/* A private puzzle is only visible to its owner and admins, and
                the report endpoint rejects it — offering the entry would lead
                them to "puzzle not found" for a puzzle they are looking at. */}
            {isPublic && (
              <button
                className="menu-item"
                type="button"
                onClick={() => {
                  // The dialog takes focus; it hands it back to the menu
                  // trigger when it closes.
                  setMenuOpen(false);
                  setReporting(true);
                }}
              >
                <Flag size={ICON_SIZE} aria-hidden="true" /> {tReport("reportLink")}
              </button>
            )}
          </ToolbarPopover>
        </div>
      </div>

      {isPublic && (
        <ReportDialog
          puzzleId={puzzle.id}
          open={reporting}
          onClose={() => {
            setReporting(false);
            moreRef.current?.focus();
          }}
        />
      )}

      <div className="solve-fullbleed" style={{ position: "relative" }}>
        {/* Always rendered: a status region announces what appears in it, and one
            that arrives together with its content is often not announced. */}
        <div role="status" className="solve-result-region">
          {result && (
            <div className="solve-result">
              <PartyPopper size={20} aria-hidden="true" />
              <div>
                <strong>
                  {t("solvedIn", {
                    time: formatDuration(result.outcome.ms),
                    moves: result.outcome.moves,
                  })}
                </strong>
                {result.beaten && (
                  <div>{t("newBest", { time: formatDuration(result.beaten.ms) })}</div>
                )}
                {!result.isNew && (
                  <div className="muted">
                    {t("bestTime", { time: formatDuration(result.best.ms) })}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={t("closeResult")}
                title={t("closeResult")}
                onClick={() => setResult(null)}
              >
                <X size={ICON_SIZE} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
        {showRef && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/image/${puzzle.imageKey}`}
            alt={t("preview")}
            className="reference-thumb"
          />
        )}
        <PuzzleBoard
          puzzle={puzzle}
          cols={cols}
          rows={rows}
          showMinimap={showMap}
          onProgress={onProgress}
          onSolved={onSolved}
          loadSolveState={loadSolveState}
          saveSolveState={saveSolveState}
          resetNonce={resetNonce}
          readTiming={readTiming}
          onSeeded={onSeeded}
          onPieceGrab={onPieceGrab}
          onPieceDrop={onPieceDrop}
          actionsRef={boardActions}
        />
      </div>
    </div>
  );
}
