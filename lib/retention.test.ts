import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expiredTokenFilter } from "./token-ttl";

const { deleteMany, verdictFindMany, verdictDeleteMany, puzzleFindMany } = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  // imageVerdict gets two mocks, not one: purgeOrphanedVerdicts now selects
  // candidates before deciding what to delete (see lib/retention.ts), so the
  // mock needs to distinguish the two calls the way the real client does.
  verdictFindMany: vi.fn(),
  verdictDeleteMany: vi.fn(),
  puzzleFindMany: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    verificationToken: { deleteMany },
    imageVerdict: { findMany: verdictFindMany, deleteMany: verdictDeleteMany },
    puzzle: { findMany: puzzleFindMany },
  },
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
  // No candidates by default, so the token-purge tests below don't have to
  // know the verdict sweep exists; tests that do care override these.
  verdictFindMany.mockResolvedValue([]);
  verdictDeleteMany.mockResolvedValue({ count: 0 });
  puzzleFindMany.mockResolvedValue([]);
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

/**
 * A minimal in-memory stand-in for the imageVerdict/puzzle tables, wired into
 * the same mock functions the module calls through `./db`. The paging tests
 * below need `skip`/`take`/`orderBy` to actually behave like Prisma's, and
 * the row set to actually shrink when a delete goes through — a single
 * `mockResolvedValue` can't express either, so those tests drive this fake
 * instead. The exact-shape tests above and below it stay on plain
 * `mockResolvedValue`, which is the right tool when there's only one call to
 * describe.
 */
function fakeVerdictStore(
  entries: { imageKey: string; createdAt: number }[],
  claimedKeys: Set<string>,
) {
  let rows = [...entries].sort(
    (a, b) => a.createdAt - b.createdAt || a.imageKey.localeCompare(b.imageKey),
  );

  verdictFindMany.mockImplementation(
    async ({
      where,
      skip = 0,
      take,
    }: {
      where: { createdAt: { lt: Date } };
      skip?: number;
      take: number;
    }) => {
      const cutoff = where.createdAt.lt.getTime();
      return rows
        .filter((row) => row.createdAt < cutoff)
        .slice(skip, skip + take)
        .map((row) => ({ imageKey: row.imageKey }));
    },
  );

  puzzleFindMany.mockImplementation(async ({ where }: { where: { imageKey: { in: string[] } } }) =>
    where.imageKey.in.filter((key) => claimedKeys.has(key)).map((imageKey) => ({ imageKey })),
  );

  verdictDeleteMany.mockImplementation(async ({ where }: { where: { imageKey: { in: string[] } } }) => {
    const toDelete = new Set(where.imageKey.in);
    const before = rows.length;
    rows = rows.filter((row) => !toDelete.has(row.imageKey));
    return { count: before - rows.length };
  });

  return { has: (key: string) => rows.some((row) => row.imageKey === key) };
}

describe("purgeOrphanedVerdicts", () => {
  it("deletes a verdict older than the grace period that no puzzle claimed", async () => {
    // An abandoned upload would otherwise keep its row for the life of the DB.
    const { purgeOrphanedVerdicts, VERDICT_GRACE_MS, VERDICT_SWEEP_BATCH } =
      await reimportRetention();
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);
    verdictDeleteMany.mockResolvedValue({ count: 1 });

    await expect(purgeOrphanedVerdicts(NOW)).resolves.toBe(1);

    // Candidates are selected by age first, with a bounded, explicitly
    // ordered, cursor-following page — not by loading every puzzle's
    // imageKey and excluding it — so the query stays cheap and safe
    // regardless of how many puzzles the instance has, and paging can't
    // repeat or skip a row depending on either database's default order.
    expect(verdictFindMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date(NOW - VERDICT_GRACE_MS) } },
      select: { imageKey: true },
      orderBy: [{ createdAt: "asc" }, { imageKey: "asc" }],
      skip: 0,
      take: VERDICT_SWEEP_BATCH,
    });
    // Only the candidates' own keys are asked about, not every puzzle's.
    expect(puzzleFindMany).toHaveBeenCalledWith({
      where: { imageKey: { in: ["uploads/orphan.webp"] } },
      select: { imageKey: true },
    });
    expect(verdictDeleteMany).toHaveBeenCalledWith({
      where: { imageKey: { in: ["uploads/orphan.webp"] } },
    });
  });

  it("keeps a verdict whose image a puzzle still uses", async () => {
    const { purgeOrphanedVerdicts } = await reimportRetention();
    verdictFindMany.mockResolvedValue([{ imageKey: "puzzles/kept.webp" }]);
    puzzleFindMany.mockResolvedValue([{ imageKey: "puzzles/kept.webp" }]);

    await purgeOrphanedVerdicts(NOW);

    const { where } = verdictDeleteMany.mock.calls[0][0];
    expect(where.imageKey.in).not.toContain("puzzles/kept.webp");
  });

  it("does not ask about claims or issue a delete when nothing is old enough", async () => {
    // An empty candidate batch is not worth a second round trip to ask the
    // puzzle table about zero keys.
    const { purgeOrphanedVerdicts } = await reimportRetention();

    await expect(purgeOrphanedVerdicts(NOW)).resolves.toBe(0);

    expect(puzzleFindMany).not.toHaveBeenCalled();
    expect(verdictDeleteMany).not.toHaveBeenCalled();
  });

  it("runs as part of the sweep, so no operator has to schedule it", async () => {
    const { maybePurgeExpiredTokens } = await reimportRetention();
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);

    await maybePurgeExpiredTokens(NOW);

    expect(verdictDeleteMany).toHaveBeenCalled();
  });

  it("does not let a verdict failure stop the token purge from counting", async () => {
    // Token deletion is the promise the privacy policy makes; verdict cleanup
    // is housekeeping and must not mask it.
    const { maybePurgeExpiredTokens } = await reimportRetention();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockResolvedValue({ count: 5 });
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);
    verdictDeleteMany.mockRejectedValue(new Error("db down"));

    // Not just "resolves" — the token count itself must come through intact.
    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBe(5);

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("purge of unclaimed image verdicts failed"),
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("still sweeps verdicts when the token purge fails", async () => {
    // The two tables are unrelated, so one being unavailable must not disable
    // cleanup of the other. This sat inside the token purge's try, after its
    // await, so a locked verificationToken table silently stopped verdict
    // deletion as well — two failures for the price of one, and the second with
    // nothing in the log to attribute it to.
    const { maybePurgeExpiredTokens } = await reimportRetention();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("permission denied for table"));
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);

    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBeNull();

    expect(verdictDeleteMany).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("examines different candidates on consecutive sweeps instead of the same batch twice", async () => {
    // The starvation this exists to prevent: `createdAt` only grows staler,
    // so a `take` with no cursor would re-select the same oldest rows on
    // every sweep once there are more candidates than fit in one batch.
    const { purgeOrphanedVerdicts, VERDICT_GRACE_MS, VERDICT_SWEEP_BATCH } =
      await reimportRetention();
    const total = VERDICT_SWEEP_BATCH * 2;
    const entries = Array.from({ length: total }, (_, i) => ({
      imageKey: `verdict-${String(i).padStart(4, "0")}`,
      createdAt: NOW - VERDICT_GRACE_MS - total + i,
    }));
    // All claimed: nothing gets deleted, isolating the paging behaviour from
    // the offset-adjustment-on-delete behaviour the next test covers.
    fakeVerdictStore(entries, new Set(entries.map((e) => e.imageKey)));

    await purgeOrphanedVerdicts(NOW);
    const firstBatch = new Set<string>(puzzleFindMany.mock.calls[0][0].where.imageKey.in);

    await purgeOrphanedVerdicts(NOW);
    const secondBatch = new Set<string>(puzzleFindMany.mock.calls[1][0].where.imageKey.in);

    expect(firstBatch.size).toBe(VERDICT_SWEEP_BATCH);
    expect(secondBatch.size).toBe(VERDICT_SWEEP_BATCH);
    for (const key of secondBatch) expect(firstBatch.has(key)).toBe(false);
  });

  it("eventually deletes a genuine orphan sitting behind a wall of claimed verdicts", async () => {
    const { purgeOrphanedVerdicts, VERDICT_GRACE_MS, VERDICT_SWEEP_BATCH } =
      await reimportRetention();
    const gap = 10_000;
    const wall = Array.from({ length: VERDICT_SWEEP_BATCH }, (_, i) => ({
      imageKey: `claimed-${String(i).padStart(4, "0")}`,
      createdAt: NOW - VERDICT_GRACE_MS - gap + i,
    }));
    // Sorts right after the wall, but is still old enough to be a candidate.
    const orphan = { imageKey: "orphan", createdAt: NOW - VERDICT_GRACE_MS - gap + wall.length };
    const store = fakeVerdictStore([...wall, orphan], new Set(wall.map((w) => w.imageKey)));

    // First sweep exhausts the wall; the orphan is one batch further along.
    await expect(purgeOrphanedVerdicts(NOW)).resolves.toBe(0);
    expect(store.has("orphan")).toBe(true);

    // Second sweep, thanks to the persisted cursor, reaches and deletes it.
    await expect(purgeOrphanedVerdicts(NOW)).resolves.toBe(1);
    expect(store.has("orphan")).toBe(false);
  });

  it("resets the paging cursor once a sweep reaches the end, instead of paging into emptiness", async () => {
    const { purgeOrphanedVerdicts, VERDICT_GRACE_MS } = await reimportRetention();
    const entries = Array.from({ length: 5 }, (_, i) => ({
      imageKey: `verdict-${i}`,
      createdAt: NOW - VERDICT_GRACE_MS - 5 + i,
    }));
    fakeVerdictStore(entries, new Set(entries.map((e) => e.imageKey)));

    // A page of 5 is short of a full batch, so the cursor should reset to 0
    // rather than advance past the end.
    await purgeOrphanedVerdicts(NOW);
    const firstBatch = puzzleFindMany.mock.calls[0][0].where.imageKey.in as string[];

    await purgeOrphanedVerdicts(NOW);
    const secondBatch = puzzleFindMany.mock.calls[1][0].where.imageKey.in as string[];

    // Without the reset, this sweep would skip past all 5 rows and find
    // nothing — the same "sweep runs forever and does nothing" failure mode,
    // just from an empty tail instead of a wall of claimed rows.
    expect(secondBatch).toEqual(firstBatch);
  });
});

describe("retentionStatus", () => {
  it("reports no success yet without calling it stale", async () => {
    // A process that has only just booted has swept nothing, which is normal.
    const { retentionStatus } = await reimportRetention();

    expect(retentionStatus(NOW)).toEqual({
      lastSuccessAt: null,
      failures: 0,
      stale: false,
      verdicts: { lastSuccessAt: null, failures: 0, stale: false },
    });
  });

  it("goes stale when only the verdict sweep is failing", async () => {
    // The privacy policy promises verdict deletion too, and this is the only
    // code path that performs it. Left out of the status, a verdict sweep
    // failing every hour forever showed a green readiness probe — exactly the
    // invisibility retentionStatus exists to end.
    const { maybePurgeExpiredTokens, retentionStatus, SWEEP_INTERVAL_MS } =
      await reimportRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);
    verdictDeleteMany.mockRejectedValue(new Error("permission denied for table"));

    for (let i = 0; i < 3; i += 1) await maybePurgeExpiredTokens(NOW + i * SWEEP_INTERVAL_MS);

    // The token half is healthy and says so; the instance is still not well.
    expect(retentionStatus(NOW)).toMatchObject({
      failures: 0,
      stale: true,
      verdicts: { failures: 3, stale: true },
    });
  });

  it("does not let a healthy token purge erase the verdict sweep's failures", async () => {
    // Why the two counters are separate. On one shared counter the token
    // purge's success resets it every hour, so a verdict sweep that fails every
    // single time oscillates 0 → 1 → 0 and can never reach the stale threshold
    // — the bug would be permanently invisible rather than merely quiet.
    const { maybePurgeExpiredTokens, retentionStatus, SWEEP_INTERVAL_MS } =
      await reimportRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockResolvedValue({ count: 1 }); // tokens succeed every time
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);
    verdictDeleteMany.mockRejectedValue(new Error("db down"));

    for (let i = 0; i < 3; i += 1) await maybePurgeExpiredTokens(NOW + i * SWEEP_INTERVAL_MS);

    expect(retentionStatus(NOW).verdicts.failures).toBe(3);
    expect(retentionStatus(NOW).stale).toBe(true);
  });

  it("clears the verdict failures once that sweep works again", async () => {
    const { maybePurgeExpiredTokens, retentionStatus, SWEEP_INTERVAL_MS } =
      await reimportRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    verdictFindMany.mockResolvedValue([{ imageKey: "uploads/orphan.webp" }]);
    verdictDeleteMany.mockRejectedValueOnce(new Error("db is having a day"));

    await maybePurgeExpiredTokens(NOW);
    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS);

    expect(retentionStatus(NOW + SWEEP_INTERVAL_MS)).toMatchObject({
      stale: false,
      verdicts: { lastSuccessAt: NOW + SWEEP_INTERVAL_MS, failures: 0, stale: false },
    });
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
