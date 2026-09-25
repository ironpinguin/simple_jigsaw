import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  puzzleFindUnique: vi.fn(),
  entryFindMany: vi.fn(),
  entryFindUnique: vi.fn(),
  entryCount: vi.fn(),
  getSessionViewer: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: m.puzzleFindUnique },
    leaderboardEntry: {
      findMany: m.entryFindMany,
      findUnique: m.entryFindUnique,
      count: m.entryCount,
    },
  },
}));
vi.mock("@/lib/auth", () => ({
  getSessionViewer: m.getSessionViewer,
  getSessionUser: m.getSessionUser,
}));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { GET } from "./route";
import { POST as START } from "./start/route";

const params = { params: Promise.resolve({ id: "p1" }) };

function row(id: string, userId: string, ms: number, moves: number, name: string) {
  return { id, userId, ms, moves, achievedAt: new Date("2026-10-01"), user: { displayName: name } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SECRET", "test-secret");
  m.getSessionViewer.mockResolvedValue(null);
  m.puzzleFindUnique.mockResolvedValue({
    isPublic: true,
    ownerId: "owner-1",
    competition: { pieceCount: 12, startsAt: null, endsAt: null },
  });
  m.entryFindMany.mockResolvedValue([
    row("e1", "u1", 30_000, 10, "Ana"),
    row("e2", "u2", 30_000, 10, "Ben"),
    row("e3", "u3", 45_000, 12, "Cleo"),
  ]);
});

describe("GET /api/competitions/[id]", () => {
  it("lists the board without an account, sharing places on a tie", async () => {
    const res = await GET(new Request("http://test"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.competition).toMatchObject({ pieceCount: 12, phase: "OPEN" });
    expect(body.entries.map((e: { rank: number }) => e.rank)).toEqual([1, 1, 3]);
    expect(body.you).toBeNull();
  });

  it("never hands out another solver's account id", async () => {
    const res = await GET(new Request("http://test"), params);
    expect(JSON.stringify(await res.json())).not.toMatch(/"u[123]"/);
  });

  it("finds the viewer's own place below the listed entries", async () => {
    m.getSessionViewer.mockResolvedValue({ id: "u9", role: "USER" });
    m.entryFindUnique.mockResolvedValue({ ms: 90_000, moves: 40 });
    m.entryCount.mockResolvedValue(24);
    const body = await (await GET(new Request("http://test"), params)).json();
    expect(body.you).toEqual({ rank: 25, ms: 90_000, moves: 40 });
  });

  it("marks the viewer's own listed entry", async () => {
    m.getSessionViewer.mockResolvedValue({ id: "u3", role: "USER" });
    const body = await (await GET(new Request("http://test"), params)).json();
    expect(body.entries.map((e: { isYou: boolean }) => e.isYou)).toEqual([false, false, true]);
    expect(body.you).toEqual({ rank: 3, ms: 45_000, moves: 12 });
  });

  it("answers 404 for a private puzzle a stranger cannot view", async () => {
    m.puzzleFindUnique.mockResolvedValue({
      isPublic: false,
      ownerId: "owner-1",
      competition: { pieceCount: 12, startsAt: null, endsAt: null },
    });
    expect((await GET(new Request("http://test"), params)).status).toBe(404);
  });
});

describe("POST /api/competitions/[id]/start", () => {
  it("issues a start token to a signed-in solver", async () => {
    m.getSessionUser.mockResolvedValue({ id: "u1", email: "u1@example.com", role: "USER" });
    const res = await START(new Request("http://test", { method: "POST" }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
  });

  it("requires an account", async () => {
    m.getSessionUser.mockResolvedValue(null);
    const res = await START(new Request("http://test", { method: "POST" }), params);
    expect(res.status).toBe(401);
  });

  it("refuses before the competition opens", async () => {
    m.getSessionUser.mockResolvedValue({ id: "u1", email: "u1@example.com", role: "USER" });
    m.puzzleFindUnique.mockResolvedValue({
      isPublic: true,
      competition: { startsAt: new Date(Date.now() + 60_000), endsAt: null },
    });
    const res = await START(new Request("http://test", { method: "POST" }), params);
    expect(res.status).toBe(409);
  });
});
