import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique, userUpdate, compareMock, resolveRequestLocaleMock } = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  compareMock: vi.fn(),
  resolveRequestLocaleMock: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
}));
vi.mock("./moderation", () => ({ checkEmailBanned: vi.fn(async () => false) }));
vi.mock("./admin-emails", () => ({ isAdminEmail: () => false }));
vi.mock("bcryptjs", () => ({ default: { compare: compareMock } }));
vi.mock("./i18n-server", () => ({ resolveRequestLocale: resolveRequestLocaleMock }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape of the captured NextAuth options isn't worth typing here
const { capturedOptions } = vi.hoisted(() => ({ capturedOptions: { value: null as any } }));
vi.mock("next-auth", () => ({
  default: (options: unknown) => {
    capturedOptions.value = options;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import "./auth";

// `providers[0].authorize` is @auth/core's own placeholder — a synchronous
// `() => null`. The function lib/auth.ts actually passed in is kept on
// `.options`, and calling the wrong one silently authorises nobody, so this
// indirection is load-bearing rather than incidental.
const authorize = () => capturedOptions.value.providers[0].options.authorize;
const CREDS = { email: "someone@example.org", password: "correct horse" };

/** A row that can log in; `locale` is what each case is actually about. */
function row(locale: string | null) {
  return {
    id: "u1",
    email: "someone@example.org",
    name: null,
    passwordHash: "$2b$hash",
    role: "USER",
    emailVerified: new Date(),
    locale,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  compareMock.mockResolvedValue(true);
  userUpdate.mockResolvedValue({});
  resolveRequestLocaleMock.mockResolvedValue("en");
});

describe("locale capture at sign-in", () => {
  it("fills in a language nobody ever established", async () => {
    // Every row predating the column, and every account an admin creates
    // outright, arrives here as null. Signing in is the first moment this
    // person's own language is observable at all.
    userFindUnique.mockResolvedValue(row(null));

    await authorize()(CREDS);

    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { locale: "en" } });
  });

  it("never overwrites a language the account already holds", async () => {
    // The guarantee that makes writing on login safe at all. An Italian who
    // picked IT once must not be reset to German by signing in from a
    // German-configured machine — which is exactly what an unconditional
    // capture would do, and why the column is nullable rather than defaulted.
    userFindUnique.mockResolvedValue(row("it"));

    await authorize()(CREDS);

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("does not write when the request resolves to the same default anyway", async () => {
    // Null plus a German browser is already what every reader falls back to, so
    // there is nothing to record and no reason to spend a write on every login.
    resolveRequestLocaleMock.mockResolvedValue("de");
    userFindUnique.mockResolvedValue(row(null));

    await authorize()(CREDS);

    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("signs the user in even when storing the language fails", async () => {
    // A write nobody asked for must never cost somebody their login.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    userFindUnique.mockResolvedValue(row(null));
    userUpdate.mockRejectedValue(new Error("db down"));

    await expect(authorize()(CREDS)).resolves.toMatchObject({ id: "u1" });

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("writes nothing when the credentials are refused", async () => {
    compareMock.mockResolvedValue(false);
    userFindUnique.mockResolvedValue(row(null));

    await expect(authorize()(CREDS)).resolves.toBeNull();

    expect(userUpdate).not.toHaveBeenCalled();
  });
});
