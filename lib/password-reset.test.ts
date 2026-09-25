import { beforeEach, describe, expect, it } from "vitest";
import {
  PROBE_LIMIT,
  PROBE_MAX_KEYS,
  PROBE_WINDOW_MS,
  RESET_EMAIL_RETRY_AFTER_MS,
  RESET_PER_EMAIL_LIMIT,
  RESET_PER_IP_LIMIT,
  RESET_RATE_WINDOW_MS,
  recordProbe,
  __resetProbeState,
} from "./password-reset";

beforeEach(() => __resetProbeState());

describe("the limits", () => {
  it("allows fewer resets per address than per IP", () => {
    // One person recovering their own account needs very few; one office behind
    // one address may legitimately have several people.
    expect(RESET_PER_EMAIL_LIMIT).toBeLessThan(RESET_PER_IP_LIMIT);
  });

  it("uses a window long enough to be worth counting", () => {
    expect(RESET_RATE_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(PROBE_WINDOW_MS).toBeLessThanOrEqual(RESET_RATE_WINDOW_MS);
  });

  it("bounds how long a spent per-address quota can hold an account shut", () => {
    // Anyone may name anyone's address, so the cap protecting an account is also
    // the lever against it. Letting one request through once the newest link is
    // this old caps the wait — and at window over limit, the rate it relaxes to
    // is the one the quota already allows in a burst.
    expect(RESET_EMAIL_RETRY_AFTER_MS).toBe(RESET_RATE_WINDOW_MS / RESET_PER_EMAIL_LIMIT);
    expect(RESET_EMAIL_RETRY_AFTER_MS).toBeLessThan(RESET_RATE_WINDOW_MS);
  });
});

describe("recordProbe", () => {
  it("allows callers up to the limit and refuses the one after", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) {
      expect(recordProbe("ip-a", 1_000)).toBe(true);
    }
    expect(recordProbe("ip-a", 1_000)).toBe(false);
  });

  it("counts each caller separately", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) recordProbe("ip-a", 1_000);
    // ip-a is spent; ip-b must be unaffected.
    expect(recordProbe("ip-b", 1_000)).toBe(true);
  });

  it("forgets attempts once the window has passed", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) recordProbe("ip-a", 1_000);
    expect(recordProbe("ip-a", 1_000)).toBe(false);
    expect(recordProbe("ip-a", 1_000 + PROBE_WINDOW_MS + 1)).toBe(true);
  });

  it("does not walk every caller on every call", () => {
    // Walking the whole map is O(callers seen in the last window). Doing it per
    // call makes a prober spread over N addresses cost O(N²) — the limiter doing
    // the attacker's work for it, on an unauthenticated endpoint. Pruning from
    // the oldest end drops each bucket once, so a run stays linear.
    const calls = 3 * PROBE_WINDOW_MS / 1_000;
    for (let i = 0; i < calls; i++) recordProbe(`ip-${i}`, 1_000 + i * 1_000);
    expect(__resetProbeState.scanned()).toBeLessThanOrEqual(2 * calls);
  });

  it("keeps the number of callers bounded under rotating addresses", () => {
    // A routed IPv6 /64 is 2^64 source addresses; every one is a fresh key.
    for (let i = 0; i < PROBE_MAX_KEYS + 500; i++) recordProbe(`ip-${i}`, 1_000);
    expect(__resetProbeState.size()).toBe(PROBE_MAX_KEYS);
    expect(__resetProbeState.scanned()).toBeLessThanOrEqual(2 * (PROBE_MAX_KEYS + 500));
  });

  it("still refuses a spent caller while others come and go", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) recordProbe("ip-a", 1_000);
    for (let i = 0; i < PROBE_MAX_KEYS - 1; i++) recordProbe(`ip-${i}`, 2_000);
    expect(recordProbe("ip-a", 3_000)).toBe(false);
  });

  it("does not grow without bound as callers come and go", () => {
    // The counter lives in the process for its lifetime; without pruning, every
    // address that ever probed would be retained until restart.
    for (let i = 0; i < 50; i++) recordProbe(`ip-${i}`, 1_000);
    // One much later call must be enough to drop the stale entries.
    recordProbe("ip-new", 1_000 + PROBE_WINDOW_MS * 10);
    expect(__resetProbeState.size()).toBeLessThanOrEqual(2);
  });
});
