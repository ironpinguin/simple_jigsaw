// Server-side best times (#127): the start, a submitted solve, and the import
// of what the browser already holds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  puzzleFindUnique: vi.fn(),
  bestFindUnique: vi.fn(),
  bestCreate: vi.fn(),
  bestUpdateMany: vi.fn(),
  getSessionViewer: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: m.puzzleFindUnique },
    bestTime: {
      findUnique: m.bestFindUnique,
      create: m.bestCreate,
      updateMany: m.bestUpdateMany,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ getSessionViewer: m.getSessionViewer }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST as SUBMIT } from "./route";
import { POST as START } from "./start/route";
import { POST as IMPORT } from "./import/route";
import { signAttemptStart } from "@/lib/attempt-token";
import { signCompetitionStart } from "@/lib/competition-token";
import { BEST_ATTEMPT_MAX_MS } from "@/lib/best-times";

const params = { params: Promise.resolve({ id: "p1" }) };
const NOW = 1_800_000_000_000;

const post = (handler: (r: Request, p: typeof params) => Promise<Response>, body?: unknown) =>
  handler(
    new Request("http://test/api/puzzles/p1/best-times", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params,
  );

const startedAt = (ago: number) => signAttemptStart("best-time-start:v1", "p1", "u1", NOW - ago);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SECRET", "test-secret");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.getSessionViewer.mockResolvedValue({ id: "u1", role: "USER" });
  m.puzzleFindUnique.mockResolvedValue({ isPublic: true, ownerId: "someone-else" });
  m.bestFindUnique.mockResolvedValue(null);
  m.bestCreate.mockResolvedValue({});
  m.bestUpdateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/puzzles/[id]/best-times/start", () => {
  it("signs a start for the solver on a puzzle they can open", async () => {
    const res = await post(START);
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token).toBe(signAttemptStart("best-time-start:v1", "p1", "u1", NOW));
  });

  it("answers 404 for a private puzzle of someone else", async () => {
    m.puzzleFindUnique.mockResolvedValue({ isPublic: false, ownerId: "someone-else" });
    expect((await post(START)).status).toBe(404);
  });

  it("serves the owner of a private puzzle", async () => {
    m.puzzleFindUnique.mockResolvedValue({ isPublic: false, ownerId: "u1" });
    expect((await post(START)).status).toBe(200);
  });

  it("requires a session", async () => {
    m.getSessionViewer.mockResolvedValue(null);
    expect((await post(START)).status).toBe(401);
  });
});

describe("POST /api/puzzles/[id]/best-times", () => {
  const solve = (extra: Record<string, unknown> = {}) => ({
    token: startedAt(120_000),
    pieceCount: 12,
    ms: 100_000,
    moves: 30,
    ...extra,
  });

  it("stores a first best", async () => {
    const res = await post(SUBMIT, solve());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ best: { ms: 100_000, moves: 30 }, improved: true });
    expect(m.bestCreate).toHaveBeenCalledWith({
      data: { userId: "u1", puzzleId: "p1", pieceCount: 12, ms: 100_000, moves: 30, achievedAt: new Date(NOW) },
    });
  });

  it("improves a standing best only where the new one still beats it", async () => {
    m.bestFindUnique.mockResolvedValueOnce({ ms: 110_000, moves: 30 });
    await post(SUBMIT, solve());
    // The condition is in the write itself, so a concurrent better time wins.
    expect(m.bestUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        puzzleId: "p1",
        pieceCount: 12,
        OR: [{ ms: { gt: 100_000 } }, { ms: 100_000, moves: { gt: 30 } }],
      },
      data: { ms: 100_000, moves: 30, achievedAt: new Date(NOW) },
    });
  });

  it("answers with the standing best when it is the better one, without writing", async () => {
    m.bestFindUnique.mockResolvedValueOnce({ ms: 90_000, moves: 25 });
    expect(await (await post(SUBMIT, solve())).json()).toEqual({
      best: { ms: 90_000, moves: 25 },
      improved: false,
    });
    expect(m.bestUpdateMany).not.toHaveBeenCalled();
    expect(m.bestFindUnique).toHaveBeenCalledTimes(1);
  });

  it("answers with the other tab's best when it landed first", async () => {
    m.bestFindUnique
      .mockResolvedValueOnce({ ms: 110_000, moves: 30 })
      .mockResolvedValueOnce({ ms: 90_000, moves: 25 });
    m.bestUpdateMany.mockResolvedValue({ count: 0 });
    expect(await (await post(SUBMIT, solve())).json()).toEqual({
      best: { ms: 90_000, moves: 25 },
      improved: false,
    });
  });

  it("refuses a time the 32-bit column cannot hold", async () => {
    const token = startedAt(BEST_ATTEMPT_MAX_MS - 60_000);
    expect((await post(SUBMIT, solve({ token, ms: 2_200_000_000 }))).status).toBe(400);
    expect(m.bestCreate).not.toHaveBeenCalled();
  });

  it("falls back to improving when another tab created the row first", async () => {
    m.bestCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    expect((await (await post(SUBMIT, solve())).json()).improved).toBe(true);
    expect(m.bestUpdateMany).toHaveBeenCalled();
  });

  it("refuses a time faster than the floor for the piece count", async () => {
    const res = await post(SUBMIT, solve({ ms: 5_000 }));
    expect(res.status).toBe(422);
    expect(m.bestCreate).not.toHaveBeenCalled();
  });

  it("refuses more time than has passed since the start", async () => {
    expect((await post(SUBMIT, solve({ ms: 600_000 }))).status).toBe(422);
  });

  it("keeps a start good for weeks, not only a day", async () => {
    const token = startedAt(BEST_ATTEMPT_MAX_MS - 60_000);
    expect((await post(SUBMIT, solve({ token, ms: 3_600_000 }))).status).toBe(200);
    const stale = startedAt(BEST_ATTEMPT_MAX_MS + 60_000);
    expect((await post(SUBMIT, solve({ token: stale }))).status).toBe(400);
  });

  it("refuses a competition's start, and one for another user", async () => {
    const competition = signCompetitionStart("p1", "u1", NOW - 120_000);
    expect((await post(SUBMIT, solve({ token: competition }))).status).toBe(400);
    const other = signAttemptStart("best-time-start:v1", "p1", "u2", NOW - 120_000);
    expect((await post(SUBMIT, solve({ token: other }))).status).toBe(400);
    expect(m.bestCreate).not.toHaveBeenCalled();
  });

  it("refuses a piece count that is not a preset", async () => {
    expect((await post(SUBMIT, solve({ pieceCount: 13 }))).status).toBe(400);
  });

  it("answers 404 for a puzzle the solver cannot open", async () => {
    m.puzzleFindUnique.mockResolvedValue({ isPublic: false, ownerId: "someone-else" });
    expect((await post(SUBMIT, solve())).status).toBe(404);
  });

  it("requires a session", async () => {
    m.getSessionViewer.mockResolvedValue(null);
    expect((await post(SUBMIT, solve())).status).toBe(401);
  });
});

describe("POST /api/puzzles/[id]/best-times/import", () => {
  it("takes over what the browser holds, per piece count", async () => {
    const res = await post(IMPORT, {
      bests: { 12: { ms: 50_000, moves: 20 }, 48: { ms: 400_000, moves: 90 } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).bests).toEqual({
      12: { ms: 50_000, moves: 20 },
      48: { ms: 400_000, moves: 90 },
    });
    expect(m.bestCreate).toHaveBeenCalledTimes(2);
  });

  it("skips a time below the floor, and a count that is not a preset, but keeps the rest", async () => {
    const res = await post(IMPORT, {
      bests: { 12: { ms: 1_000, moves: 5 }, 13: { ms: 50_000, moves: 20 }, 48: { ms: 400_000, moves: 90 } },
    });
    expect((await res.json()).bests).toEqual({ 48: { ms: 400_000, moves: 90 } });
    expect(m.bestCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body", async () => {
    expect((await post(IMPORT, { bests: { 12: { ms: -1, moves: 5 } } })).status).toBe(400);
    expect((await post(IMPORT, { bests: { 12: { ms: 2 ** 31, moves: 5 } } })).status).toBe(400);
    expect((await post(IMPORT, { bests: "nope" })).status).toBe(400);
  });

  it("answers 404 for a puzzle the solver cannot open", async () => {
    m.puzzleFindUnique.mockResolvedValue({ isPublic: false, ownerId: "someone-else" });
    expect((await post(IMPORT, { bests: {} })).status).toBe(404);
  });

  it("requires a session", async () => {
    m.getSessionViewer.mockResolvedValue(null);
    expect((await post(IMPORT, { bests: {} })).status).toBe(401);
  });
});
