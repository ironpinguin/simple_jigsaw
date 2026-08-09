import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expiredTokenFilter } from "./token-ttl";

const { deleteMany } = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("./db", () => ({
  prisma: { verificationToken: { deleteMany } },
}));

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

/**
 * The throttle keeps its state on globalThis rather than in module scope —
 * Next emits lib/retention once per webpack layer, so module scope would give
 * each layer its own throttle instead of one shared per process. That means
 * `vi.resetModules()` no longer clears it: the global key has to be cleared
 * by hand so every test starts from a known, unthrottled state.
 */
const globalForRetention = globalThis as unknown as { lastSweepAt?: number | null };

async function freshRetention() {
  vi.resetModules();
  return import("./retention");
}

beforeEach(() => {
  deleteMany.mockResolvedValue({ count: 0 });
  delete globalForRetention.lastSweepAt;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("purgeExpiredTokens", () => {
  it("deletes the expired rows and reports how many", async () => {
    const { purgeExpiredTokens } = await freshRetention();
    deleteMany.mockResolvedValue({ count: 7 });

    await expect(purgeExpiredTokens(NOW)).resolves.toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });
});

describe("maybePurgeExpiredTokens", () => {
  it("sweeps on the first call", async () => {
    const { maybePurgeExpiredTokens } = await freshRetention();
    deleteMany.mockResolvedValue({ count: 3 });

    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });

  it("does nothing when called again inside the interval", async () => {
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await freshRetention();
    await maybePurgeExpiredTokens(NOW);

    await expect(maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS - 1)).resolves.toBeNull();
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("sweeps again once the interval has passed", async () => {
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await freshRetention();
    await maybePurgeExpiredTokens(NOW);

    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS);

    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it("sweeps once when two callers arrive together", async () => {
    // The timestamp is stamped before the await. Without that, two probes
    // landing in the same tick would both find the sweep due and both issue a
    // table-wide DELETE.
    const { maybePurgeExpiredTokens } = await freshRetention();

    await Promise.all([maybePurgeExpiredTokens(NOW), maybePurgeExpiredTokens(NOW)]);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("logs a failed sweep instead of throwing", async () => {
    // Callers are a readiness probe, a startup timer with nobody to catch it,
    // and token issuance — none of them may fail because housekeeping did. It
    // must not be silent either: the privacy policy promises this runs.
    const { maybePurgeExpiredTokens } = await freshRetention();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("db is having a day"));

    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBeNull();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("purge of expired tokens failed"),
      expect.any(Error),
    );
  });

  it("does not retry a failed sweep until the interval is up", async () => {
    // A database that rejects the DELETE will still reject it a second later.
    // Retrying on every probe would hammer it while it is already unwell.
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await freshRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("db is having a day"));

    await maybePurgeExpiredTokens(NOW);
    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS - 1);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});
