// The moment a puzzle is solved: fireworks over the page and a round of applause
// (issue #117). Browser-only — call it from an event handler, never a render.

const FIREWORKS_MS = 3500;

/** Clears whatever the current celebration still has running. */
let stopCurrent: (() => void) | null = null;

/**
 * Keys that are held rather than pressed — the modifier keys of the UI Events
 * key list. A bare one does not end the celebration.
 */
const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/** Run a cleanup; this is decoration, so a failing one must not stop the rest. */
function runQuietly(stop: () => void): void {
  try {
    stop();
  } catch {
    // Nothing to recover: whatever it was clearing is not the solve.
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

async function fireworks(): Promise<() => void> {
  // Loaded on demand: most visits never solve, and the module touches the DOM.
  const { default: confetti } = await import("canvas-confetti");
  const end = Date.now() + FIREWORKS_MS;
  const burst = (xMin: number, xMax: number, share: number) =>
    confetti({
      particleCount: Math.round(50 * share),
      startVelocity: 30,
      spread: 360,
      ticks: 60,
      // Above the board. The library's canvas ignores pointer events, so the
      // board stays usable while it plays.
      zIndex: 1000,
      origin: { x: xMin + Math.random() * (xMax - xMin), y: Math.random() * 0.4 },
    });
  const timer = setInterval(() => {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(timer);
      return;
    }
    burst(0.1, 0.3, left / FIREWORKS_MS);
    burst(0.7, 0.9, left / FIREWORKS_MS);
  }, 250);
  return () => {
    clearInterval(timer);
    confetti.reset();
  };
}

/**
 * The applause recording. A plain file under `public/` so an installation can
 * swap it without a rebuild — see "Applaus austauschen" in the README. The
 * bundled one is CC0; its source is in NOTICE.
 */
export const APPLAUSE_URL = "/sounds/applause.mp3";

/**
 * Start the applause and return its stop. Not async on purpose: `play()` only
 * settles once the file has loaded, and a stop that had to wait for that could
 * not cancel a pending play — the recording would still start, however briefly,
 * after the solver had already moved on.
 */
function applause(): () => void {
  let audio: HTMLAudioElement;
  try {
    audio = new Audio(APPLAUSE_URL);
    audio.volume = 0.8;
    // Autoplay rules allow sound only after a user gesture. Releasing the last
    // piece is one, but a browser may still refuse, and a missing or unreadable
    // file fails the same way; either rejects here. So does a `pause()` before
    // playback started (AbortError).
    audio.play().catch(() => {});
  } catch {
    return () => {};
  }
  return () => {
    audio.pause();
    // Dropping the source (rather than setting "") ends the download too.
    audio.removeAttribute("src");
    audio.load();
  };
}

/**
 * Celebrate once. `sound: false` skips the applause; `prefers-reduced-motion`
 * skips the fireworks. Anything the browser refuses — audio blocked, the file
 * missing — is dropped quietly: the solved banner is the message, this is
 * decoration. The next click, tap or key press anywhere ends it.
 */
export function celebrate({ sound }: { sound: boolean }): void {
  stopCelebration();
  const motion = !prefersReducedMotion();
  // Nothing to show or play: no listeners to leave behind either.
  if (!motion && !sound) return;

  const stops: Array<() => void> = [];
  let stopped = false;
  if (motion) {
    fireworks().then(
      (stop) => (stopped ? runQuietly(stop) : stops.push(stop)),
      () => {},
    );
  }
  if (sound) stops.push(applause());

  // Any click, tap or key ends it early. Listened for rather than caught: the
  // confetti canvas lets pointer events through, and the press should still do
  // what it does — pick up a piece, press a button — besides ending the show.
  // Capture phase, so a handler that stops propagation cannot swallow it. A key
  // repeat is not a new press: it belongs to a key held since before the solve.
  const onPress = (e: Event) => {
    if (e instanceof KeyboardEvent && (e.repeat || MODIFIER_KEYS.has(e.key))) return;
    stopCelebration();
  };
  document.addEventListener("pointerdown", onPress, true);
  document.addEventListener("keydown", onPress, true);

  stopCurrent = () => {
    stopped = true;
    document.removeEventListener("pointerdown", onPress, true);
    document.removeEventListener("keydown", onPress, true);
    for (const stop of stops) runQuietly(stop);
  };
}

/**
 * End a running celebration early — on the next click or key press, or when the
 * solver starts over.
 */
export function stopCelebration(): void {
  // Cleared before running, so a stop can never run twice.
  const stop = stopCurrent;
  stopCurrent = null;
  stop?.();
}
