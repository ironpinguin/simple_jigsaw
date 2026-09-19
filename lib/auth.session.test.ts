import { beforeEach, describe, expect, it, vi } from "vitest";

// These cases all use the id "u1" with a different mocked row each time, which
// only works because lib/auth.ts's readSessionUser is wrapped in React.cache
// and React.cache is a pass-through outside a render — there is no dispatcher
// under vitest, so nothing is memoized. If that ever changes, the first case's
// row would be served to all of them and this file would fail loudly rather
// than quietly: that is the intended signal, not something to work around by
// varying the id.

const { userFindUnique } = vi.hoisted(() => ({ userFindUnique: vi.fn() }));

vi.mock("./db", () => ({ prisma: { user: { findUnique: userFindUnique } } }));
vi.mock("./moderation", () => ({ checkEmailBanned: vi.fn(async () => false) }));
vi.mock("./admin-emails", () => ({ isAdminEmail: () => false }));

// NextAuth is called for its side effect of building the config; capture the
// options object so the callback can be exercised directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape of the captured NextAuth options isn't worth typing here
const { capturedOptions } = vi.hoisted(() => ({ capturedOptions: { value: null as any } }));
vi.mock("next-auth", () => ({
  default: (options: unknown) => {
    capturedOptions.value = options;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import "./auth";

const jwtCallback = () => capturedOptions.value.callbacks.jwt;

describe("the jwt callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps id and role at sign-in without asking the database", async () => {
    const token = await jwtCallback()({
      token: {},
      user: { id: "u1", role: "ADMIN" },
    });
    expect(token).toMatchObject({ id: "u1", role: "ADMIN" });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("keeps a session when the password has never changed", async () => {
    userFindUnique.mockResolvedValue({ passwordChangedAt: null, role: "USER" });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000 } });
    expect(token).not.toBeNull();
  });

  it("ends a session issued before the password changed", async () => {
    // This is the whole feature: a cookie taken before the change stops working.
    userFindUnique.mockResolvedValue({ passwordChangedAt: new Date(1_001_000), role: "USER" });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000 } });
    expect(token).toBeNull();
  });

  it("keeps a session issued after the password changed", async () => {
    // Past SESSION_CUTOFF_MARGIN_MS: the cutoff reaches a second beyond the
    // stamp to cover cookies re-issued while the write was still in flight
    // (see lib/session-freshness.ts), so 1_002 would still be refused.
    userFindUnique.mockResolvedValue({ passwordChangedAt: new Date(1_001_000), role: "USER" });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_003 } });
    expect(token).not.toBeNull();
  });

  it("takes the role from the row, so a demotion is not frozen in the token", async () => {
    // getSessionViewer has always read the role from the database rather than
    // the claim; the claim now agrees, so the Admin link in the nav goes away
    // with the demotion instead of when the token expires.
    userFindUnique.mockResolvedValue({ passwordChangedAt: null, role: "USER" });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000, role: "ADMIN" } });
    expect(token).toMatchObject({ role: "USER" });
  });

  it("ends a session whose user is gone", async () => {
    userFindUnique.mockResolvedValue(null);
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000 } });
    expect(token).toBeNull();
  });

  it("refuses a token with no id, since there is nothing to check it against", async () => {
    // Fail closed: an id-less token cannot be looked up or dated, so it must
    // not be trusted. (It also happens to keep app/[locale]/my/page.tsx safe —
    // that route filters puzzles by session.user.id, and Prisma drops an
    // undefined filter, so a waved-through id-less session would list every
    // user's puzzles. Unreachable as long as this stays null.)
    const token = await jwtCallback()({ token: { iat: 1_000 } });
    expect(token).toBeNull();
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
