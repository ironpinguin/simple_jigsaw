import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique, tokenCount, tokenCreate, bannedMock, sendResetMock, hashIpMock } =
  vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    tokenCount: vi.fn(),
    tokenCreate: vi.fn(),
    bannedMock: vi.fn(),
    sendResetMock: vi.fn(),
    hashIpMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique }, verificationToken: { count: tokenCount, create: tokenCreate } },
}));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: bannedMock }));
vi.mock("@/lib/mail", () => ({ sendPasswordResetEmail: sendResetMock }));
vi.mock("@/lib/report-ip", () => ({ hashReporterIp: hashIpMock }));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  resolveRequestLocale: async () => "de",
}));

import { POST } from "./route";
import { __resetProbeState } from "@/lib/password-reset";

function call(body: unknown) {
  return POST(
    new Request("http://test/api/account/password/reset-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Every branch must produce exactly this. */
async function assertSameAnswer(res: Response) {
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
}

describe("POST /api/account/password/reset-request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetProbeState();
    hashIpMock.mockReturnValue("ip-hash");
    bannedMock.mockResolvedValue(false);
    tokenCount.mockResolvedValue(0);
    tokenCreate.mockResolvedValue({ token: "tok" });
    userFindUnique.mockResolvedValue({ id: "u1", email: "a@b.de", passwordHash: "$2b$h", emailVerified: null });
  });

  it("sends a link for an eligible account", async () => {
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).toHaveBeenCalledTimes(1);
  });

  it("sends one to an account that never confirmed its address", async () => {
    // Deliberate departure from #42's original scope: an unverified account is
    // exactly the person with no other way back in. Completing the reset marks
    // the address verified.
    userFindUnique.mockResolvedValue({ id: "u1", email: "a@b.de", passwordHash: "$2b$h", emailVerified: null });
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).toHaveBeenCalledTimes(1);
  });

  it("answers the same for an address with no account, and sends nothing", async () => {
    userFindUnique.mockResolvedValue(null);
    await assertSameAnswer(await call({ email: "nobody@example.com" }));
    expect(sendResetMock).not.toHaveBeenCalled();
    expect(tokenCreate).not.toHaveBeenCalled();
  });

  it("answers the same for a banned address, and sends nothing", async () => {
    bannedMock.mockResolvedValue(true);
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("answers the same for an invited row that never set a password, and sends nothing", async () => {
    // Those belong to the invite flow (#33). A reset link would be a second,
    // quieter activation path.
    userFindUnique.mockResolvedValue({ id: "u1", email: "a@b.de", passwordHash: null, emailVerified: null });
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("answers the same when the per-address limit is spent, and sends nothing", async () => {
    tokenCount.mockResolvedValue(99);
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("answers the same for a malformed body, and sends nothing", async () => {
    await assertSameAnswer(await call({ email: "not-an-email" }));
    await assertSameAnswer(await call(null));
    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("stops a caller probing many unknown addresses", async () => {
    // The database count cannot see these: an unknown address creates no row.
    userFindUnique.mockResolvedValue(null);
    for (let i = 0; i < 25; i++) await call({ email: `probe-${i}@example.com` });
    // Still the same answer — being throttled must not be observable either.
    await assertSameAnswer(await call({ email: "probe-final@example.com" }));
    expect(userFindUnique.mock.calls.length).toBeLessThan(25);
  });

  it("records the requesting IP hash on the token it creates", async () => {
    await call({ email: "a@b.de" });
    expect(tokenCreate.mock.calls[0][0].data.requesterIpHash).toBe("ip-hash");
  });
});
