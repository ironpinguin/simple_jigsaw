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
 * `vi.resetModules()` no longer clears it: the global has to be deleted by
 * hand so every test starts from a known, unthrottled state.
 */
function resetRetentionState() {
  delete globalThis.__jigsawRetention;
}

/** A new module instance, standing in for another webpack layer. */
async function reimportRetention() {
  vi.resetModules();
  return import("./retention");
}

beforeEach(() => {
  deleteMany.mockResolvedValue({ count: 0 });
  resetRetentionState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // Leave nothing behind: the file would otherwise finish with the throttle
  // stamped, which only stays harmless while Vitest isolates test files.
  resetRetentionState();
});

describe("SWEEP_INTERVAL_MS", () => {
  it("is one hour", async () => {
    // Pinned to the literal, not derived: "at most one sweep an hour" is a
    // claim the privacy policy, the README and the k8s docs all repeat, and
    // every other test here computes from this constant rather than checking it.
    const { SWEEP_INTERVAL_MS } = await reimportRetention();

    expect(SWEEP_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

describe("purgeExpiredTokens", () => {
  it("deletes the expired rows and reports how many", async () => {
    const { purgeExpiredTokens } = await reimportRetention();
    deleteMany.mockResolvedValue({ count: 7 });

    await expect(purgeExpiredTokens(NOW)).resolves.toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });
});

describe("maybePurgeExpiredTokens", () => {
  it("sweeps on the first call", async () => {
    const { maybePurgeExpiredTokens } = await reimportRetention();
    deleteMany.mockResolvedValue({ count: 3 });

    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });

  it("does nothing when called again inside the interval", async () => {
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await reimportRetention();
    await maybePurgeExpiredTokens(NOW);

    await expect(maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS - 1)).resolves.toBeNull();
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("sweeps again once the interval has passed", async () => {
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await reimportRetention();
    await maybePurgeExpiredTokens(NOW);

    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS);

    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it("shares one budget across module instances", async () => {
    // The reason the throttle sits on globalThis. Next emits this module once
    // per webpack layer — instrumentation.ts and the route handlers each get
    // their own copy — so module-scoped state would give each layer its own
    // hourly budget, and a pod would sweep once per hour *per layer*. Nothing
    // else in this file can catch that: every other test holds one instance.
    const first = await reimportRetention();
    await first.maybePurgeExpiredTokens(NOW);

    const second = await reimportRetention();

    await expect(second.maybePurgeExpiredTokens(NOW)).resolves.toBeNull();
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("defaults to the current clock", async () => {
    // Both production callers that matter — the readiness probe and the
    // startup timer — call with no argument.
    const { maybePurgeExpiredTokens } = await reimportRetention();

    await maybePurgeExpiredTokens();
    await maybePurgeExpiredTokens();

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("sweeps once when two callers arrive together", async () => {
    // The timestamp is stamped before the await. Without that, two probes
    // landing in the same tick would both find the sweep due and both issue a
    // table-wide DELETE.
    const { maybePurgeExpiredTokens } = await reimportRetention();

    await Promise.all([maybePurgeExpiredTokens(NOW), maybePurgeExpiredTokens(NOW)]);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("logs a failed sweep instead of throwing", async () => {
    // Callers are a readiness probe, a startup timer with nobody to catch it,
    // and token issuance — none of them may fail because housekeeping did. It
    // must not be silent either: the privacy policy promises this runs.
    const { maybePurgeExpiredTokens } = await reimportRetention();
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
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await reimportRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("db is having a day"));

    await maybePurgeExpiredTokens(NOW);
    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS - 1);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("says how many it deleted, but stays quiet when there was nothing", async () => {
    // An operator needs evidence the deletion the policy promises happens at
    // all; an idle instance must not log every hour to provide it.
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await reimportRetention();
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});

    await maybePurgeExpiredTokens(NOW);
    expect(logged).not.toHaveBeenCalled();

    deleteMany.mockResolvedValue({ count: 4 });
    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS);

    expect(logged).toHaveBeenCalledWith(expect.stringContaining("4"));
  });
});

describe("retentionStatus", () => {
  it("reports no success yet without calling it stale", async () => {
    // A process that has only just booted has swept nothing, which is normal.
    const { retentionStatus } = await reimportRetention();

    expect(retentionStatus(NOW)).toEqual({ lastSuccessAt: null, failures: 0, stale: false });
  });

  it("records when the sweep last actually worked", async () => {
    const { maybePurgeExpiredTokens, retentionStatus } = await reimportRetention();

    await maybePurgeExpiredTokens(NOW);

    expect(retentionStatus(NOW)).toMatchObject({ lastSuccessAt: NOW, failures: 0 });
  });

  it("goes stale once several windows pass with no successful sweep", async () => {
    // The failure this exists for: SELECT 1 keeps succeeding — a role without
    // delete rights, a full disk, a read-only SQLite mount — so the readiness
    // probe is green while expired personal data piles up.
    const { maybePurgeExpiredTokens, retentionStatus, SWEEP_INTERVAL_MS } =
      await reimportRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("permission denied for table"));

    for (let i = 0; i < 3; i += 1) await maybePurgeExpiredTokens(NOW + i * SWEEP_INTERVAL_MS);

    expect(retentionStatus(NOW)).toMatchObject({ failures: 3, stale: true });
  });

  it("goes stale when a once-working sweep stops", async () => {
    const { maybePurgeExpiredTokens, retentionStatus, SWEEP_INTERVAL_MS } =
      await reimportRetention();
    await maybePurgeExpiredTokens(NOW);

    expect(retentionStatus(NOW + 2 * SWEEP_INTERVAL_MS).stale).toBe(false);
    expect(retentionStatus(NOW + 4 * SWEEP_INTERVAL_MS).stale).toBe(true);
  });

  it("clears the failure count after a sweep succeeds again", async () => {
    const { maybePurgeExpiredTokens, retentionStatus, SWEEP_INTERVAL_MS } =
      await reimportRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValueOnce(new Error("db is having a day"));

    await maybePurgeExpiredTokens(NOW);
    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS);

    expect(retentionStatus(NOW + SWEEP_INTERVAL_MS)).toMatchObject({ failures: 0, stale: false });
  });
});

describe("startRetentionSweeps", () => {
  it("sweeps immediately and then every interval, without holding the process open", async () => {
    const { startRetentionSweeps, SWEEP_INTERVAL_MS } = await reimportRetention();
    const unref = vi.fn();
    const schedule = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as never);

    startRetentionSweeps();
    await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), SWEEP_INTERVAL_MS);
    // Without unref, retention housekeeping alone would keep node alive.
    expect(unref).toHaveBeenCalled();
  });

  it("sweeps again when the timer fires", async () => {
    // Only Date is faked: vi.waitFor below still needs real timers to poll.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { startRetentionSweeps, SWEEP_INTERVAL_MS } = await reimportRetention();
    const schedule = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref: vi.fn() } as never);

    startRetentionSweeps();
    await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));

    // The throttle is what decides whether the tick does anything, so advance
    // the clock past it rather than mocking the throttle out.
    vi.setSystemTime(NOW + SWEEP_INTERVAL_MS);
    const tick = schedule.mock.calls[0][0] as () => void;
    tick();

    await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(2));
  });
});
