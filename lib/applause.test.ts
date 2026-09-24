import { describe, expect, it } from "vitest";
import { APPLAUSE_SECONDS, applauseEnvelope, applauseSamples } from "./applause";
import { mulberry32 } from "./puzzle/prng";

const RATE = 8000;

/** Mean square of `samples` between two times, in seconds. */
function energy(samples: Float32Array, from: number, to: number) {
  let sum = 0;
  const a = Math.floor(from * RATE);
  const b = Math.floor(to * RATE);
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return sum / (b - a);
}

describe("applauseEnvelope", () => {
  it("swells from silence and fades back to it", () => {
    expect(applauseEnvelope(0)).toBe(0);
    expect(applauseEnvelope(APPLAUSE_SECONDS)).toBe(0);
    expect(applauseEnvelope(-1)).toBe(0);
    expect(applauseEnvelope(1)).toBe(1);
    for (let t = 0; t < APPLAUSE_SECONDS; t += 0.05) {
      expect(applauseEnvelope(t)).toBeGreaterThanOrEqual(0);
      expect(applauseEnvelope(t)).toBeLessThanOrEqual(1);
    }
  });
});

describe("applauseSamples", () => {
  const samples = applauseSamples(RATE, mulberry32(117));

  it("lasts APPLAUSE_SECONDS and never clips", () => {
    expect(samples.length).toBe(RATE * APPLAUSE_SECONDS);
    for (const s of samples) expect(Math.abs(s)).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it("is audible, loudest in the middle and dies away at the end", () => {
    const middle = energy(samples, 0.5, 1.5);
    expect(middle).toBeGreaterThan(1e-3);
    expect(energy(samples, APPLAUSE_SECONDS - 0.3, APPLAUSE_SECONDS)).toBeLessThan(middle / 10);
  });

  it("is reproducible from a seeded rng", () => {
    expect(applauseSamples(RATE, mulberry32(117))).toEqual(samples);
    expect(applauseSamples(RATE, mulberry32(118))).not.toEqual(samples);
  });
});
