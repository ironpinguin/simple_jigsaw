import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  puzzleFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  entryFindUnique: vi.fn(),
  entryCreate: vi.fn(),
  entryUpdateMany: vi.fn(),
  entryCount: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: m.puzzleFindUnique },
    user: { findUnique: m.userFindUnique, update: m.userUpdate },
    leaderboardEntry: {
      findUnique: m.entryFindUnique,
      create: m.entryCreate,
      updateMany: m.entryUpdateMany,
      count: m.entryCount,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: m.getSessionUser }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { signCompetitionStart } from "@/lib/competition-token";
import { POST } from "./route";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const USER = { id: "u1", email: "u1@example.com", role: "USER" };

function competition(over: Record<string, unknown> = {}) {
  return {
    isPublic: true,
    competition: { pieceCount: 12, startsAt: null, endsAt: null, ...over },
  };
}

/** A token as the start route would have issued it `agoMs` before now. */
function token(agoMs: number, userId = "u1", puzzleId = "p1") {
  return signCompetitionStart(puzzleId, userId, NOW - agoMs);
}

function submit(body: Record<string, unknown>) {
  return POST(
    new Request("http://test/api/competitions/p1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The count the competition() fixture runs at, unless a test says otherwise.
      body: JSON.stringify({ pieceCount: 12, ...body }),
    }),
    { params: Promise.resolve({ id: "p1" }) },
  );
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error?: string }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("AUTH_SECRET", "test-secret");
  m.getSessionUser.mockResolvedValue(USER);
  m.puzzleFindUnique.mockResolvedValue(competition());
  m.userFindUnique.mockResolvedValue({ displayName: "Puzzle Fan" });
  m.entryFindUnique.mockResolvedValue(null);
  m.entryCreate.mockResolvedValue({});
  m.entryUpdateMany.mockResolvedValue({ count: 1 });
  m.entryCount.mockResolvedValue(2);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/competitions/[id]/entries", () => {
  it("enters a first result and answers with its place", async () => {
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      improved: true,
      best: { ms: 60_000, moves: 20 },
      rank: 3,
      displayName: "Puzzle Fan",
    });
    expect(m.entryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ competitionId: "p1", userId: "u1", ms: 60_000, moves: 20 }),
    });
  });

  it("keeps a better standing entry and still says where the solver stands", async () => {
    m.entryFindUnique.mockResolvedValue({ ms: 50_000, moves: 30 });
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });

    expect(await res.json()).toMatchObject({ improved: false, best: { ms: 50_000, moves: 30 } });
    expect(m.entryCreate).not.toHaveBeenCalled();
    expect(m.entryUpdateMany).not.toHaveBeenCalled();
  });

  it("improves a standing entry only where it is still worse", async () => {
    m.entryFindUnique.mockResolvedValue({ ms: 90_000, moves: 30 });
    await submit({ token: token(70_000), ms: 60_000, moves: 20 });

    // The condition in the write is what stops a slower tab finishing at the
    // same moment from overwriting this.
    expect(m.entryUpdateMany).toHaveBeenCalledWith({
      where: {
        competitionId: "p1",
        userId: "u1",
        OR: [{ ms: { gt: 60_000 } }, { ms: 60_000, moves: { gt: 20 } }],
      },
      data: expect.objectContaining({ ms: 60_000, moves: 20 }),
    });
  });

  it("falls back to improving when another tab created the entry in between", async () => {
    m.entryCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });

    expect(res.status).toBe(200);
    expect(m.entryUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("answers with the standing entry when another tab's better time landed first", async () => {
    m.entryFindUnique
      .mockResolvedValueOnce({ ms: 90_000, moves: 30 })
      .mockResolvedValueOnce({ ms: 55_000, moves: 18 });
    m.entryUpdateMany.mockResolvedValue({ count: 0 });
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });

    expect(await res.json()).toMatchObject({ improved: false, best: { ms: 55_000, moves: 18 } });
  });

  it("refuses a result solved at another piece count than the competition's", async () => {
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20, pieceCount: 48 });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("competitionCountChanged");
    expect(m.entryCreate).not.toHaveBeenCalled();
  });

  it("refuses a move count the column cannot hold", async () => {
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 3_000_000_000 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalidInput");
    expect(m.entryCreate).not.toHaveBeenCalled();
  });

  it("refuses without a session", async () => {
    m.getSessionUser.mockResolvedValue(null);
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });
    expect(res.status).toBe(401);
  });

  it.each([
    ["no competition", { isPublic: true, competition: null }],
    ["a private puzzle", { ...competition(), isPublic: false }],
    ["no puzzle", null],
  ])("answers 404 for %s", async (_, puzzle) => {
    m.puzzleFindUnique.mockResolvedValue(puzzle);
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("competitionNotFound");
  });

  it("refuses once the competition has ended, also for an attempt started before", async () => {
    m.puzzleFindUnique.mockResolvedValue(competition({ endsAt: new Date(NOW - 1_000) }));
    const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("competitionNotOpen");
  });

  it.each([
    ["issued to someone else", () => token(70_000, "u2")],
    ["issued for another puzzle", () => token(70_000, "u1", "p2")],
    ["forged", () => `${NOW - 70_000}.${"A".repeat(43)}`],
    ["older than a day", () => token(25 * 60 * 60 * 1000)],
  ])("refuses a start token %s", async (_, make) => {
    const res = await submit({ token: make(), ms: 60_000, moves: 20 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("attemptInvalid");
    expect(m.entryCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["faster than the floor for the piece count", 70_000, 5_000],
    ["longer than the attempt has been running", 30_000, 60_000],
  ])("refuses a time %s", async (_, ago, ms) => {
    const res = await submit({ token: token(ago), ms, moves: 20 });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toBe("resultImplausible");
    expect(m.entryCreate).not.toHaveBeenCalled();
  });

  describe("the display name", () => {
    beforeEach(() => m.userFindUnique.mockResolvedValue({ displayName: null }));

    it("asks for one before the first entry", async () => {
      const res = await submit({ token: token(70_000), ms: 60_000, moves: 20 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "displayNameRequired",
        code: "displayNameRequired",
      });
      expect(m.entryCreate).not.toHaveBeenCalled();
    });

    it("stores the chosen one, normalised, and enters the result", async () => {
      const res = await submit({
        token: token(70_000),
        ms: 60_000,
        moves: 20,
        displayName: "  Puzzle   Fan ",
      });
      expect(res.status).toBe(200);
      expect(m.userUpdate).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { displayName: "Puzzle Fan" },
      });
      expect(m.entryCreate).toHaveBeenCalled();
    });

    it("refuses an invalid one without entering anything", async () => {
      const res = await submit({ token: token(70_000), ms: 60_000, moves: 20, displayName: "x" });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe("displayNameInvalid");
      expect(m.userUpdate).not.toHaveBeenCalled();
      expect(m.entryCreate).not.toHaveBeenCalled();
    });

    it("ignores one sent when the account already has a name", async () => {
      m.userFindUnique.mockResolvedValue({ displayName: "Puzzle Fan" });
      await submit({ token: token(70_000), ms: 60_000, moves: 20, displayName: "Other" });
      expect(m.userUpdate).not.toHaveBeenCalled();
    });
  });

  it("rejects a malformed body", async () => {
    const res = await submit({ token: token(70_000), ms: -1, moves: 0 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalidInput");
  });
});
