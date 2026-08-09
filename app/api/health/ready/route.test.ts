import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw, maybePurge } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  maybePurge: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@/lib/retention", () => ({ maybePurgeExpiredTokens: maybePurge }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ one: 1 }]);
  maybePurge.mockResolvedValue(null);
});

describe("GET /api/health/ready", () => {
  it("reports the database as up and asks for a sweep", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, db: "up" });
    expect(maybePurge).toHaveBeenCalled();
  });

  it("answers 503 when the database does not", async () => {
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await GET();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, db: "down" });
  });

  it("does not sweep when the database is down", async () => {
    // The sweep would only fail too, and it would take the throttle's hourly
    // budget with it.
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));

    await GET();

    expect(maybePurge).not.toHaveBeenCalled();
  });

  it("stays ready when the sweep throws", async () => {
    // maybePurgeExpiredTokens handles its own failures, so this can only be a
    // bug in the throttle itself — and retention housekeeping must never take
    // a pod out of the load balancer.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    maybePurge.mockRejectedValue(new Error("sweep exploded"));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("puts no error detail in the response", async () => {
    // The endpoint is public, and Prisma's connection errors quote the DSN.
    queryRaw.mockRejectedValue(new Error("password authentication failed for user jigsaw"));

    const res = await GET();

    await expect(res.text()).resolves.not.toContain("password");
  });
});
