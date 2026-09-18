import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminMock, userFindMany } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findMany: userFindMany } } }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { GET } from "./route";

const HASH = "$2b$10$notarealhashbutlongenough";

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "someone@example.com",
    name: "Someone",
    role: "USER",
    emailVerified: null,
    passwordHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("GET /api/admin/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue(true);
    userFindMany.mockResolvedValue([]);
  });

  it("refuses a caller who is not an admin, without reaching the database", async () => {
    requireAdminMock.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  it("reports hasPassword false for a row that has never been given a hash", async () => {
    // This is the row the re-invite button is offered on: an invitation that was
    // never redeemed. Reporting it as `true` hides the button and strands the
    // invitee, which is #33 again for that row.
    userFindMany.mockResolvedValue([dbRow({ passwordHash: null })]);
    const { users } = await (await GET()).json();
    expect(users[0].hasPassword).toBe(false);
  });

  it("reports hasPassword true for a row that has one", async () => {
    // And this is the row the button must stay away from — the account is in
    // use, and the invite route answers 409 rather than mint a link for it.
    userFindMany.mockResolvedValue([dbRow({ passwordHash: HASH })]);
    const { users } = await (await GET()).json();
    expect(users[0].hasPassword).toBe(true);
  });

  it("never puts the hash in the response, whatever else it carries", async () => {
    userFindMany.mockResolvedValue([dbRow({ passwordHash: HASH, emailVerified: new Date() })]);
    const res = await GET();
    const body = await res.clone().json();

    expect(body.users[0]).not.toHaveProperty("passwordHash");
    expect(body.users[0]).not.toHaveProperty("emailVerified");
    // Against the serialised body too: a hash reaching the client is the one
    // failure here that cannot be taken back once it has been sent.
    expect(await res.text()).not.toContain(HASH);
  });

  it("derives verified from emailVerified and keeps the rest of the row", async () => {
    userFindMany.mockResolvedValue([
      dbRow({ id: "a", emailVerified: null }),
      dbRow({ id: "b", email: "other@example.com", role: "ADMIN", emailVerified: new Date() }),
    ]);
    const { users } = await (await GET()).json();

    expect(users.map((u: { id: string; verified: boolean }) => [u.id, u.verified])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(users[1]).toMatchObject({ email: "other@example.com", role: "ADMIN" });
  });

  it("selects the hash it derives from, rather than only the columns it returns", async () => {
    // The whole boolean hangs off this select, exactly as the invite route's
    // does. Narrow it to the returned columns — the obvious "we never send the
    // hash, why fetch it" cleanup — and `passwordHash` is undefined,
    // `undefined !== null` is true, and every account reports hasPassword true.
    await GET();
    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ passwordHash: true, emailVerified: true }),
      }),
    );
  });
});
