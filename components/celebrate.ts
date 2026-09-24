// The moment a puzzle is solved: fireworks over the page and a round of applause
// (issue #117). Browser-only — call it from an event handler, never a render.

import { applauseSamples } from "@/lib/applause";

const FIREWORKS_MS = 3500;

/** Clears whatever the current celebration still has running. */
let stopCurrent: (() => void) | null = null;

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
      disableForReducedMotion: true,
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

async function applause(): Promise<() => void> {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  // Autoplay rules allow sound only after a user gesture. Releasing the last
  // piece is one, but a browser may still refuse; that rejects here.
  await ctx.resume();

  const samples = applauseSamples(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);

  // Take the hiss off both ends so it reads as hands, not static.
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1500;
  band.Q.value = 0.6;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(band).connect(ctx.destination);
  source.onended = () => void ctx.close();
  source.start();
  return () => {
    source.onended = null;
    void ctx.close();
  };
}

/**
 * Celebrate once. `sound: false` skips the applause; `prefers-reduced-motion`
 * skips the fireworks. Anything the browser refuses — audio blocked, no Web
 * Audio at all — is dropped quietly: the solved banner is the message, this is
 * decoration.
 */
export function celebrate({ sound }: { sound: boolean }): void {
  stopCelebration();
  const stops: Array<() => void> = [];
  let stopped = false;
  const keep = (p: Promise<() => void>) =>
    p.then(
      (stop) => (stopped ? stop() : stops.push(stop)),
      () => {},
    );
  if (!prefersReducedMotion()) keep(fireworks());
  if (sound) keep(applause());
  stopCurrent = () => {
    stopped = true;
    for (const stop of stops) stop();
  };
}

/** End a running celebration early, e.g. when the solver starts over. */
export function stopCelebration(): void {
  stopCurrent?.();
  stopCurrent = null;
}
