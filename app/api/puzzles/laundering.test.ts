// The two halves that made a flagged image publishable, exercised together.
//
// Each half was correct on its own and each had its own passing test:
// lib/retention.ts deletes a verdict no puzzle references once it is past the
// grace period, and app/api/puzzles reads "no verdict row" as an image from
// before this feature. Nothing deletes the stored *object* for an unclaimed
// key, so the sequence below — upload something explicit, never claim the key,
// let the sweep remove the verdict, then create the puzzle against the
// remembered key — turned a FLAGGED image into a public puzzle with no report
// and no admin ever involved. This test drives the whole sequence against one
// in-memory store shared by the sweep and the route, because the halves only
// misbehave in each other's company.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StoredPuzzle = { id: string; imageKey: string; ownerId: string; isPublic: boolean };
type StoredVerdict = {
  imageKey: string;
  label: string;
  score: number;
  model: string;
  createdAt: Date;
};
type StoredReport = { puzzleId: string; category: string; message: string };

const { store, prismaFake, getSessionUserMock } = vi.hoisted(() => {
  const store = {
    puzzles: [] as StoredPuzzle[],
    verdicts: [] as StoredVerdict[],
    reports: [] as StoredReport[],
    nextPuzzleId: 1,
  };

  // Only the operations these two modules actually issue, behaving the way the
  // real client does — in particular `distinct`, which the route relies on to
  // answer both of its questions with one read.
  const prismaFake = {
    puzzle: {
      findMany: async ({
        where,
        distinct,
      }: {
        where: { imageKey: string | { in: string[] } };
        distinct?: string[];
      }) => {
        const key = where.imageKey;
        const rows = store.puzzles.filter((puzzle) =>
          typeof key === "string" ? puzzle.imageKey === key : key.in.includes(puzzle.imageKey),
        );
        if (!distinct) return rows.map(({ imageKey }) => ({ imageKey }));
        const owners = new Set<string>();
        for (const row of rows) owners.add(row.ownerId);
        return [...owners].map((ownerId) => ({ ownerId }));
      },
      create: async ({ data }: { data: StoredPuzzle }) => {
        const created = {
          id: `p${store.nextPuzzleId++}`,
          imageKey: data.imageKey,
          ownerId: data.ownerId,
          isPublic: data.isPublic,
        };
        store.puzzles.push(created);
        return created;
      },
    },
    imageVerdict: {
      findUnique: async ({ where }: { where: { imageKey: string } }) =>
        store.verdicts.find((verdict) => verdict.imageKey === where.imageKey) ?? null,
      findMany: async ({
        where,
        skip = 0,
        take,
      }: {
        where: { createdAt: { lt: Date } };
        skip?: number;
        take: number;
      }) =>
        store.verdicts
          .filter((verdict) => verdict.createdAt < where.createdAt.lt)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.imageKey.localeCompare(b.imageKey),
          )
          .slice(skip, skip + take)
          .map(({ imageKey }) => ({ imageKey })),
      deleteMany: async ({ where }: { where: { imageKey: { in: string[] } } }) => {
        const doomed = new Set(where.imageKey.in);
        const before = store.verdicts.length;
        store.verdicts = store.verdicts.filter((verdict) => !doomed.has(verdict.imageKey));
        return { count: before - store.verdicts.length };
      },
    },
    report: {
      create: async ({ data }: { data: StoredReport }) => {
        store.reports.push(data);
        return data;
      },
    },
    verificationToken: { deleteMany: async () => ({ count: 0 }) },
    // One connection in this fake, so the transaction body just runs.
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prismaFake),
  };

  return { store, prismaFake, getSessionUserMock: vi.fn() };
});

vi.mock("@/lib/db", () => ({ prisma: prismaFake }));
vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST } from "./route";
import { purgeOrphanedVerdicts, VERDICT_GRACE_MS } from "@/lib/retention";

const KEY = "puzzles/0f4d2c1e-explicit.webp";
const UPLOADED_AT = Date.UTC(2026, 7, 1, 12, 0, 0);

function createPuzzle() {
  return POST(
    new Request("http://test/api/puzzles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Holiday photo",
        imageKey: KEY,
        imageWidth: 800,
        imageHeight: 600,
        pieceCount: 48,
        isPublic: true,
      }),
    }),
  );
}

beforeEach(() => {
  store.puzzles = [];
  store.verdicts = [];
  store.reports = [];
  store.nextPuzzleId = 1;
  getSessionUserMock.mockResolvedValue({ id: "owner-1", role: "USER" });
  // The sweep's paging cursor lives on globalThis (see lib/retention.ts), so
  // it survives module resets and has to be cleared by hand.
  delete globalThis.__jigsawRetention;
  vi.stubEnv("NSFW_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete globalThis.__jigsawRetention;
});

describe("claiming a key whose verdict the sweep already removed", () => {
  it("holds the puzzle and files a report instead of publishing it", async () => {
    // 1. Upload. The classifier flags the bytes and the verdict is stored;
    //    the object itself is in storage under KEY from here on, whatever
    //    happens to the row.
    store.verdicts.push({
      imageKey: KEY,
      label: "FLAGGED",
      score: 0.97,
      model: "local:image-safety-classifier-xs@54f4560",
      createdAt: new Date(UPLOADED_AT),
    });

    // 2. The user never creates the puzzle. Once the grace period is up the
    //    sweep sees a verdict no puzzle references and deletes it as an
    //    abandoned upload — correct in isolation, and the only trace of the
    //    classifier's decision.
    const sweptAt = UPLOADED_AT + VERDICT_GRACE_MS + 60_000;
    await expect(purgeOrphanedVerdicts(sweptAt)).resolves.toBe(1);
    expect(store.verdicts).toHaveLength(0);

    // 3. The user now submits the create form with the key they were handed
    //    at upload time. Before the fix this published the image outright.
    const res = await createPuzzle();

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: true });
    expect(store.puzzles[0].isPublic).toBe(false);
    expect(store.reports).toHaveLength(1);
    expect(store.reports[0]).toMatchObject({ puzzleId: "p1", category: "AUTO_NSFW" });
  });

  it("leaves the ordinary flow — claim before the sweep — publishing as before", async () => {
    // The same store and the same route, differing only in that the verdict
    // is still there: a clean image is not collateral damage of the fix.
    store.verdicts.push({
      imageKey: KEY,
      label: "CLEAN",
      score: 0.02,
      model: "local:image-safety-classifier-xs@54f4560",
      createdAt: new Date(UPLOADED_AT),
    });

    const res = await createPuzzle();

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ id: "p1", pendingReview: false });
    expect(store.puzzles[0].isPublic).toBe(true);
    expect(store.reports).toHaveLength(0);
  });

  it("keeps the verdict of a key a puzzle has claimed, however old", async () => {
    // The other side of the same coin: once the puzzle exists the verdict is
    // no longer an orphan, so the sweep must leave it alone and the row stays
    // available for a re-check.
    store.verdicts.push({
      imageKey: KEY,
      label: "CLEAN",
      score: 0.02,
      model: "local:image-safety-classifier-xs@54f4560",
      createdAt: new Date(UPLOADED_AT),
    });
    await createPuzzle();

    await expect(
      purgeOrphanedVerdicts(UPLOADED_AT + VERDICT_GRACE_MS + 60_000),
    ).resolves.toBe(0);
    expect(store.verdicts).toHaveLength(1);
  });
});
