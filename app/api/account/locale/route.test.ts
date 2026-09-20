import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUserMock, userUpdate } = vi.hoisted(() => ({
  getSessionUserMock: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: userUpdate } } }));
// The key rather than the translation: these assertions are about which message
// the route picks, and pinning the German copy would break on any rewording.
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { PUT } from "./route";

function call(body: unknown) {
  return PUT(
    new Request("http://test/api/account/locale", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PUT /api/account/locale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionUserMock.mockResolvedValue({ id: "u1", email: "a@b.de", role: "USER" });
    userUpdate.mockResolvedValue({});
  });

  it("stores the chosen locale on the session's own row", async () => {
    const res = await call({ locale: "it" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { locale: "it" } });
  });

  it("takes the id from the session, never from the body", async () => {
    // The only writer of somebody else's locale would be this one — the body is
    // attacker-controlled and the session is not.
    await call({ locale: "en", id: "someone-else" });

    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { locale: "en" } });
  });

  it("refuses without a session, without touching the database", async () => {
    getSessionUserMock.mockResolvedValue(null);

    const res = await call({ locale: "en" });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "notLoggedIn" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a locale the app does not have, rather than writing it", async () => {
    // The column is a plain String on both providers, so nothing below this
    // route would stop "fr" — and a row holding it silently falls back to the
    // default forever after.
    const res = await call({ locale: "fr" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalidRequest" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const res = await PUT(
      new Request("http://test/api/account/locale", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("reports a failed write instead of answering ok", async () => {
    // The switcher ignores the response, but an operator debugging "my mail is
    // still German" needs the trace, and a silent 200 would hide it.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userUpdate.mockRejectedValue(new Error("db down"));

    const res = await call({ locale: "en" });

    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
