import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw, maybePurge, status } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  maybePurge: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@/lib/retention", () => ({
  maybePurgeExpiredTokens: maybePurge,
  retentionStatus: status,
}));

import { GET, dynamic } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ one: 1 }]);
  maybePurge.mockResolvedValue(null);
  status.mockReturnValue({ lastSuccessAt: null, failures: 0, stale: false });
});

describe("GET /api/health/ready", () => {
  it("reports the database as up and asks for a sweep", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, db: "up", retention: "ok" });
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

  it("does not wait for the sweep", async () => {
    // A table-wide DELETE blocked on a lock would otherwise hold the probe
    // open past the 5s timeout the k8s and compose configs give it, and the
    // result is unused anyway.
    maybePurge.mockReturnValue(new Promise(() => {}));

    await expect(GET()).resolves.toMatchObject({ status: 200 });
  });

  it("stays ready when the sweep throws", async () => {
    // maybePurgeExpiredTokens handles its own failures, so this can only be a
    // bug in the throttle itself — and retention housekeeping must never take
    // a pod out of the load balancer.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    maybePurge.mockRejectedValue(new Error("sweep exploded"));

    const res = await GET();

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    logged.mockRestore();
  });

  it("says so when the sweep has stopped working, without failing the probe", async () => {
    // SELECT 1 says nothing about whether the DELETE works. A pod whose sweep
    // is stuck still serves traffic, so this must not take it out of the
    // Service — but it must not be invisible either.
    status.mockReturnValue({ lastSuccessAt: 0, failures: 4, stale: true });

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, db: "up", retention: "stale" });
  });

  it("puts no error detail in the response", async () => {
    // The endpoint is public, and Prisma's connection errors quote the DSN.
    queryRaw.mockRejectedValue(new Error("password authentication failed for user jigsaw"));

    const res = await GET();

    await expect(res.text()).resolves.not.toContain("password");
  });

  it("is not cacheable, ready or not", async () => {
    // A cached 200 keeps a pod in the Service after its database has gone.
    const ok = await GET();
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));
    const down = await GET();

    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(down.headers.get("cache-control")).toBe("no-store");
  });

  it("is never statically optimized", async () => {
    // Without this, Next may answer from a build-time render: the SELECT 1
    // stops running per request and the endpoint reports ready forever.
    expect(dynamic).toBe("force-dynamic");
  });
});
