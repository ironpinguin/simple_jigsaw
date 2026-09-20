import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUserMock, userFindUnique, puzzleFindMany } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  userFindUnique: vi.fn(),
  puzzleFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique }, puzzle: { findMany: puzzleFindMany } },
}));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { GET, dynamic } from "./route";

const row = {
  id: "user-1",
  email: "someone@example.org",
  name: "Someone",
  role: "USER",
  emailVerified: new Date(Date.UTC(2026, 0, 2)),
  termsAcceptedAt: new Date(Date.UTC(2026, 0, 3)),
  locale: "it",
  termsVersion: "2026-01-01",
  createdAt: new Date(Date.UTC(2026, 0, 1)),
};

const puzzleRow = {
  id: "puzzle-1",
  title: "Urlaub",
  imageKey: "abc123.webp",
  imageWidth: 1600,
  imageHeight: 900,
  pieceCount: 100,
  cols: 10,
  rows: 10,
  seed: 42,
  isPublic: true,
  createdAt: new Date(Date.UTC(2026, 0, 4)),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Cleared, not deleted: the route's copy of lib/account-export bound this Map
  // when it was imported, so replacing the global would leave that copy holding
  // the old one and the throttle would leak from test to test.
  globalThis.__jigsawExportHits?.clear();
  vi.stubEnv("APP_URL", "https://jigsaw.example.org");
  getSessionUserMock.mockResolvedValue({ id: "user-1", email: "someone@example.org" });
  userFindUnique.mockResolvedValue(row);
  puzzleFindMany.mockResolvedValue([puzzleRow]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.__jigsawExportHits?.clear();
});

describe("GET /api/account/export", () => {
  it("hands the logged-in user their own data", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.account.email).toBe("someone@example.org");
    expect(body.puzzles).toHaveLength(1);
  });

  it("reads only the rows belonging to that user", async () => {
    // The session id, never anything from the request: this endpoint must not
    // be able to export somebody else's account.
    await GET();

    expect(userFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
    expect(puzzleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: "user-1" } }),
    );
  });

  it("turns anonymous callers away", async () => {
    getSessionUserMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("never selects the password hash from the database", async () => {
    // Cheaper than trusting the builder alone: the column is not even read.
    await GET();

    const select = userFindUnique.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("passwordHash");
    expect(await (await GET()).text()).not.toContain("passwordHash");
  });

  it("offers the payload as a download rather than a page", async () => {
    const res = await GET();

    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("is not cacheable", async () => {
    // It is the whole account in one response; no shared cache should keep it.
    const res = await GET();

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 429 once the user has taken their allowance", async () => {
    const { EXPORT_RATE_LIMIT } = await import("@/lib/account-export");
    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) await GET();

    const res = await GET();

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "tooManyRequests" });
  });

  it("does not touch the database once it is rate-limited", async () => {
    const { EXPORT_RATE_LIMIT } = await import("@/lib/account-export");
    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) await GET();
    vi.clearAllMocks();
    getSessionUserMock.mockResolvedValue({ id: "user-1" });

    await GET();

    expect(puzzleFindMany).not.toHaveBeenCalled();
  });

  it("answers 404 when the session outlives the account row", async () => {
    userFindUnique.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(404);
  });

  it("does not spend an export on a request the database failed to answer", async () => {
    // Otherwise five blips cost the user their whole hourly allowance, and the
    // sixth attempt tells them they asked too often — blaming them for a fault
    // on this side.
    const { EXPORT_RATE_LIMIT } = await import("@/lib/account-export");
    puzzleFindMany.mockRejectedValue(new Error("connection lost"));
    for (let i = 0; i < EXPORT_RATE_LIMIT + 1; i += 1) {
      await expect(GET()).rejects.toThrow("connection lost");
    }
    puzzleFindMany.mockResolvedValue([puzzleRow]);

    const res = await GET();

    expect(res.status).toBe(200);
  });

  it("does not spend an export when there is no account row to export", async () => {
    const { EXPORT_RATE_LIMIT } = await import("@/lib/account-export");
    userFindUnique.mockResolvedValue(null);
    for (let i = 0; i < EXPORT_RATE_LIMIT + 1; i += 1) {
      expect((await GET()).status).toBe(404);
    }
    userFindUnique.mockResolvedValue(row);

    const res = await GET();

    expect(res.status).toBe(200);
  });

  it("is never statically optimized", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
