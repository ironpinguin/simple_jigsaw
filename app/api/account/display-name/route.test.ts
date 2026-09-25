import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ update: vi.fn(), getSessionUser: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { user: { update: m.update } } }));
vi.mock("@/lib/auth", () => ({ getSessionUser: m.getSessionUser }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { PATCH } from "./route";

const call = (body: unknown) =>
  PATCH(
    new Request("http://test/api/account/display-name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.getSessionUser.mockResolvedValue({ id: "u1", email: "u1@example.com", role: "USER" });
  m.update.mockResolvedValue({});
});

describe("PATCH /api/account/display-name", () => {
  it("stores the normalised name", async () => {
    const res = await call({ displayName: " New   Name " });
    expect(await res.json()).toEqual({ displayName: "New Name" });
    expect(m.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { displayName: "New Name" } });
  });

  it("refuses an invalid name", async () => {
    const res = await call({ displayName: "x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("displayNameInvalid");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    m.getSessionUser.mockResolvedValue(null);
    expect((await call({ displayName: "Fine Name" })).status).toBe(401);
  });
});
