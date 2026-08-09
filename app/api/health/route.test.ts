import { describe, expect, it, vi } from "vitest";

// The liveness probe has to answer while the database is unreachable, or a
// Postgres blip restarts every pod. Making the client throw on access pins
// that as behaviour instead of trusting a comment not to rot.
vi.mock("@/lib/db", () => ({
  get prisma(): never {
    throw new Error("the liveness probe must not touch the database");
  },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  it("answers 200 without touching the database", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("is not cacheable", async () => {
    // A cached 200 would keep reporting a healthy process after it stopped
    // being one.
    const res = await GET();

    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
