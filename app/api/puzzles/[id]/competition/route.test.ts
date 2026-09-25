import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  puzzleFindUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    puzzle: { findUnique: m.puzzleFindUnique },
    competition: { upsert: m.upsert, deleteMany: m.deleteMany },
  },
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: m.getSessionUser }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { DELETE, PUT } from "./route";

const params = { params: Promise.resolve({ id: "p1" }) };

function put(body: unknown) {
  return PUT(
    new Request("http://test/api/puzzles/p1/competition", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );
}

const SETTINGS = { pieceCount: 48, startsAt: "2026-10-01T10:00:00.000Z", endsAt: null };

async function errorOf(res: Response) {
  return ((await res.json()) as { error?: string }).error;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getSessionUser.mockResolvedValue({ id: "owner-1", email: "o@example.com", role: "USER" });
  m.puzzleFindUnique.mockResolvedValue({ ownerId: "owner-1", isPublic: true, competition: null });
  m.upsert.mockImplementation(async ({ create }) => create);
  m.deleteMany.mockResolvedValue({ count: 1 });
});

describe("PUT /api/puzzles/[id]/competition", () => {
  it("turns the owner's public puzzle into a competition", async () => {
    const res = await put(SETTINGS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ competition: SETTINGS });
    expect(m.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { puzzleId: "p1" },
        create: {
          puzzleId: "p1",
          pieceCount: 48,
          startsAt: new Date("2026-10-01T10:00:00Z"),
          endsAt: null,
        },
      }),
    );
  });

  it("answers 404 for someone else's puzzle", async () => {
    m.puzzleFindUnique.mockResolvedValue({ ownerId: "other", isPublic: true, competition: null });
    const res = await put(SETTINGS);
    expect(res.status).toBe(404);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("refuses a private puzzle", async () => {
    m.puzzleFindUnique.mockResolvedValue({ ownerId: "owner-1", isPublic: false, competition: null });
    const res = await put(SETTINGS);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("competitionNeedsPublic");
  });

  it("refuses a new piece count once there are entries, but allows a new window", async () => {
    m.puzzleFindUnique.mockResolvedValue({
      ownerId: "owner-1",
      isPublic: true,
      competition: { pieceCount: 12, _count: { entries: 3 } },
    });
    const changed = await put(SETTINGS);
    expect(changed.status).toBe(409);
    expect(await errorOf(changed)).toBe("competitionHasEntries");

    const sameCount = await put({ ...SETTINGS, pieceCount: 12 });
    expect(sameCount.status).toBe(200);
  });

  it("allows a new piece count while nobody has entered yet", async () => {
    m.puzzleFindUnique.mockResolvedValue({
      ownerId: "owner-1",
      isPublic: true,
      competition: { pieceCount: 12, _count: { entries: 0 } },
    });
    expect((await put(SETTINGS)).status).toBe(200);
  });

  it("rejects invalid settings", async () => {
    const res = await put({ ...SETTINGS, pieceCount: 50 });
    expect(res.status).toBe(400);
  });

  it("requires a session", async () => {
    m.getSessionUser.mockResolvedValue(null);
    expect((await put(SETTINGS)).status).toBe(401);
  });
});

describe("DELETE /api/puzzles/[id]/competition", () => {
  it("ends the owner's competition, scoped to the owner in the write", async () => {
    const res = await DELETE(new Request("http://test", { method: "DELETE" }), params);
    expect(res.status).toBe(200);
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: { puzzleId: "p1", puzzle: { ownerId: "owner-1" } },
    });
  });

  it("answers 404 when there is nothing of the owner's to end", async () => {
    m.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(new Request("http://test", { method: "DELETE" }), params);
    expect(res.status).toBe(404);
  });
});
