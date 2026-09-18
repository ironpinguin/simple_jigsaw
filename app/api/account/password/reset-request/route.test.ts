import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  userFindUnique,
  tokenCount,
  tokenCreate,
  bannedMock,
  sendResetMock,
  hashIpMock,
  hasTrustedProxyMock,
} = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  tokenCount: vi.fn(),
  tokenCreate: vi.fn(),
  bannedMock: vi.fn(),
  sendResetMock: vi.fn(),
  hashIpMock: vi.fn(),
  hasTrustedProxyMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique }, verificationToken: { count: tokenCount, create: tokenCreate } },
}));
vi.mock("@/lib/moderation", () => ({ checkEmailBanned: bannedMock }));
vi.mock("@/lib/mail", () => ({ sendPasswordResetEmail: sendResetMock }));
vi.mock("@/lib/report-ip", () => ({
  hashReporterIp: hashIpMock,
  hasTrustedProxy: hasTrustedProxyMock,
}));
vi.mock("@/lib/i18n-server", () => ({
  getErrorT: async () => (key: string) => key,
  resolveRequestLocale: async () => "de",
}));

import { POST } from "./route";
import { __resetProbeState, PROBE_LIMIT } from "@/lib/password-reset";

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
    hasTrustedProxyMock.mockReturnValue(false);
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

  it("stops a caller probing many unknown addresses, behind a trusted proxy", async () => {
    // The database count cannot see these: an unknown address creates no row.
    // Enforcement requires a trusted proxy — see the next test for why it must
    // not apply on the shipped default, where every visitor shares one bucket.
    hasTrustedProxyMock.mockReturnValue(true);
    userFindUnique.mockResolvedValue(null);
    const attempts = PROBE_LIMIT + 5;
    for (let i = 0; i < attempts; i++) await call({ email: `probe-${i}@example.com` });
    // Still the same answer — being throttled must not be observable either.
    await assertSameAnswer(await call({ email: "probe-final@example.com" }));
    expect(userFindUnique.mock.calls.length).toBeLessThan(attempts);
  });

  it("does not let the probe counter deny service deployment-wide without a trusted proxy", async () => {
    // With the shipped default (no trusted proxy), hashReporterIp collapses
    // every visitor into one shared bucket. Enforcing PROBE_LIMIT there would
    // let one caller sustaining a steady rate keep it permanently full and
    // silently kill password recovery for everyone else behind it.
    hasTrustedProxyMock.mockReturnValue(false);
    const attempts = PROBE_LIMIT + 5;
    for (let i = 0; i < attempts; i++) {
      await assertSameAnswer(await call({ email: "a@b.de" }));
    }
    expect(sendResetMock).toHaveBeenCalledTimes(attempts);
  });

  it("records the requesting IP hash on the token it creates", async () => {
    await call({ email: "a@b.de" });
    expect(tokenCreate.mock.calls[0][0].data.requesterIpHash).toBe("ip-hash");
  });

  it("answers the same, rather than 500, when the per-email rate-limit count throws", async () => {
    // The realistic trigger: a rolling deploy where db:push has not yet added
    // requesterIpHash. Reachable only for an address that exists, is unbanned
    // and has a hash — so an uncaught throw here would 500 only for real
    // accounts while unknown addresses still got 200, the same enumeration
    // oracle the mail-send catch exists to close.
    tokenCount.mockRejectedValueOnce(new Error("column requesterIpHash does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
  });

  it("answers the same when sending the mail fails, and does not revoke the token it already created", async () => {
    // Reachable only for an address that exists, is unbanned, has a hash and is
    // under its limit — exactly where a distinguishable response (even a 500)
    // would turn mail trouble into an oracle for which addresses have accounts.
    sendResetMock.mockRejectedValueOnce(new Error("smtp down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(tokenCreate).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
  });

  it("consults, and can be limited by, the per-IP durable count behind a trusted proxy", async () => {
    hasTrustedProxyMock.mockReturnValue(true);
    tokenCount.mockImplementation(async ({ where }: { where: { requesterIpHash?: string } }) =>
      where.requesterIpHash ? 99 : 0,
    );
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).not.toHaveBeenCalled();
    expect(tokenCount).toHaveBeenCalledTimes(2);
  });

  it("does not consult the per-IP count, or let another caller's shared-bucket usage block this one, without a trusted proxy", async () => {
    hasTrustedProxyMock.mockReturnValue(false);
    // Would trip RESET_PER_IP_LIMIT if consulted — proof it isn't, on the
    // shipped default where every visitor hashes to one shared bucket.
    tokenCount.mockImplementation(async ({ where }: { where: { requesterIpHash?: string } }) =>
      where.requesterIpHash ? 99 : 0,
    );
    await assertSameAnswer(await call({ email: "a@b.de" }));
    expect(sendResetMock).toHaveBeenCalledTimes(1);
    expect(tokenCount).toHaveBeenCalledTimes(1);
  });
});
