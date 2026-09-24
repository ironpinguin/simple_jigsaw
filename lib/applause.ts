// A few seconds of applause, synthesised rather than recorded: a crowd's clapping
// is a dense stream of short, bright noise bursts whose rate swells and fades, and
// generating that here means no audio asset to ship or licence (issue #117). Pure
// — the caller hands the samples to Web Audio — so it is testable in plain node.

export const APPLAUSE_SECONDS = 3;

/** Claps per second at the loudest moment, summed over the whole crowd. */
const PEAK_RATE = 70;

/** One clap: a few milliseconds of noise with a fast exponential decay. */
const CLAP_SECONDS = 0.012;

/** 0..1 — how much of the crowd is clapping `t` seconds in. */
export function applauseEnvelope(t: number, seconds = APPLAUSE_SECONDS): number {
  if (t < 0 || t >= seconds) return 0;
  const swell = Math.min(1, t / 0.25);
  const fadeStart = seconds * 0.55;
  const fade = t < fadeStart ? 1 : 1 - (t - fadeStart) / (seconds - fadeStart);
  return swell * fade * fade;
}

/**
 * Mono samples in [-1, 1] at `sampleRate`. `rng` must return [0, 1); pass a
 * seeded one to make the output reproducible.
 */
export function applauseSamples(
  sampleRate: number,
  rng: () => number = Math.random,
  seconds = APPLAUSE_SECONDS,
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  const clapLen = Math.floor(sampleRate * CLAP_SECONDS);
  const decay = 5 / clapLen; // down to e^-5 by the end of a clap

  // Walk time in small steps and drop in claps at the envelope's rate, so the
  // crowd thins out towards the end rather than just getting quieter.
  const step = Math.max(1, Math.floor(sampleRate / 1000));
  for (let i = 0; i < out.length; i += step) {
    const rate = PEAK_RATE * applauseEnvelope(i / sampleRate, seconds);
    if (rng() >= (rate * step) / sampleRate) continue;
    const gain = 0.25 + 0.35 * rng();
    const start = i + Math.floor(rng() * step);
    for (let k = 0; k < clapLen && start + k < out.length; k++) {
      out[start + k] += gain * (rng() * 2 - 1) * Math.exp(-decay * k);
    }
  }

  // Overlapping claps can add past full scale; normalise rather than clip.
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  if (peak > 0.9) for (let i = 0; i < out.length; i++) out[i] *= 0.9 / peak;
  return out;
}
