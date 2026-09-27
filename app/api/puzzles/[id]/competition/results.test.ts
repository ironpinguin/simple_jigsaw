// Ending a competition and downloading its leaderboard (#139).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  puzzleFindUnique: vi.fn(),
  competitionUpdate: vi.fn(),
  entryFindMany: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: m.puzzleFindUnique },
    competition: { update: m.competitionUpdate },
    leaderboardEntry: { findMany: m.entryFindMany },
  },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: m.getSessionUser }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  resolveRequestLocale: async () => "en",
}));
// The headings are the translator's keys, so the test sees which one went where.
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import { POST as END } from "./end/route";
import { GET as DOWNLOAD } from "./leaderboard/route";

const params = { params: Promise.resolve({ id: "p1" }) };
const NOW = new Date("2026-09-27T12:00:00.000Z");

const end = () => END(new Request("http://test/api/puzzles/p1/competition/end", { method: "POST" }), params);
const download = () => DOWNLOAD(new Request("http://test/api/puzzles/p1/competition/leaderboard"), params);

function owned(competition: unknown, extra: Record<string, unknown> = {}) {
  m.puzzleFindUnique.mockResolvedValue({ ownerId: "owner-1", title: "Gardasee", competition, ...extra });
}

function row(id: string, ms: number, moves: number, name: string | null) {
  return { id, userId: `u-${id}`, ms, moves, achievedAt: new Date("2026-09-20T08:00:00Z"), user: { displayName: name } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.getSessionUser.mockResolvedValue({ id: "owner-1", email: "o@example.com", role: "USER" });
  m.competitionUpdate.mockImplementation(async ({ data }) => ({ pieceCount: 48, ...data }));
});

afterEach(() => vi.useRealTimers());

describe("POST /api/puzzles/[id]/competition/end", () => {
  it("closes a running competition now and keeps it, instead of deleting it", async () => {
    owned({ pieceCount: 48, startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: null });

    const res = await end();

    expect(res.status).toBe(200);
    expect(m.competitionUpdate).toHaveBeenCalledWith({
      where: { puzzleId: "p1" },
      data: { startsAt: new Date("2026-09-01T00:00:00Z"), endsAt: NOW },
    });
    expect((await res.json()).competition).toEqual({
      pieceCount: 48,
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: NOW.toISOString(),
    });
  });

  it("pulls the start of an upcoming competition forward, so the window stays in order", async () => {
    owned({ pieceCount: 48, startsAt: new Date("2026-12-01T00:00:00Z"), endsAt: null });

    await end();

    expect(m.competitionUpdate).toHaveBeenCalledWith({
      where: { puzzleId: "p1" },
      data: { startsAt: NOW, endsAt: NOW },
    });
  });

  it("leaves an already ended competition's end date alone", async () => {
    const endsAt = new Date("2026-09-10T00:00:00Z");
    owned({ pieceCount: 48, startsAt: null, endsAt });

    const res = await end();

    expect(res.status).toBe(200);
    expect(m.competitionUpdate).not.toHaveBeenCalled();
    expect((await res.json()).competition.endsAt).toBe(endsAt.toISOString());
  });

  it("answers 404 for someone else's puzzle, without writing", async () => {
    owned({ pieceCount: 48, startsAt: null, endsAt: null }, { ownerId: "someone-else" });
    expect((await end()).status).toBe(404);
    expect(m.competitionUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 when the puzzle has no competition", async () => {
    owned(null);
    expect((await end()).status).toBe(404);
  });

  it("requires a session", async () => {
    m.getSessionUser.mockResolvedValue(null);
    expect((await end()).status).toBe(401);
  });
});

describe("GET /api/puzzles/[id]/competition/leaderboard", () => {
  beforeEach(() => {
    owned({ puzzleId: "p1" });
    m.entryFindMany.mockResolvedValue([
      row("e1", 30_000, 10, "Ana"),
      row("e2", 30_000, 10, "=cmd|' /C calc'!A0"),
      row("e3", 95_000, 12, "Cleo"),
    ]);
  });

  it("hands the owner every entry as a CSV attachment", async () => {
    const res = await download();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="leaderboard-gardasee.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // All of them: no `take`, unlike the board shown on the page.
    expect(m.entryFindMany.mock.calls[0][0].take).toBeUndefined();
  });

  it("ranks like the board, ties sharing a place, and defuses formula-like names", async () => {
    const lines = (await (await download()).text()).replace(/^\uFEFF/, "").trimEnd().split("\r\n");

    expect(lines).toEqual([
      "csvRank,csvDisplayName,csvTime,csvMs,csvMoves,csvAchievedAt",
      "1,Ana,0:30,30000,10,2026-09-20T08:00:00.000Z",
      "1,'=cmd|' /C calc'!A0,0:30,30000,10,2026-09-20T08:00:00.000Z",
      "3,Cleo,1:35,95000,12,2026-09-20T08:00:00.000Z",
    ]);
  });

  it("never carries an account id or email", async () => {
    const csv = await (await download()).text();
    expect(csv).not.toContain("u-e1");
    expect(m.entryFindMany.mock.calls[0][0].select.user).toEqual({ select: { displayName: true } });
  });

  it("answers 404 for someone else's puzzle, admins included", async () => {
    m.getSessionUser.mockResolvedValue({ id: "admin-1", email: "a@example.com", role: "ADMIN" });
    expect((await download()).status).toBe(404);
    expect(m.entryFindMany).not.toHaveBeenCalled();
  });

  it("answers 404 when the puzzle has no competition", async () => {
    owned(null);
    expect((await download()).status).toBe(404);
  });

  it("requires a session", async () => {
    m.getSessionUser.mockResolvedValue(null);
    expect((await download()).status).toBe(401);
  });
});
