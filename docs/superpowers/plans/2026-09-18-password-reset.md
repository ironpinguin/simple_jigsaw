# Password reset by email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Someone who has forgotten their password can get back in through a single-use, rate-limited, enumeration-safe email link — and doing so ends every other session.

**Architecture:** A new `PASSWORD_RESET` token kind (2 h) reuses the existing `createToken`/`consumeToken` machinery. A public request endpoint always answers the same 200, rate-limited from token rows for real accounts and from an in-process counter for probing. Completing a reset writes `passwordHash`, `passwordChangedAt` and `emailVerified` in one update, so the session invalidation built in the previous branch applies unchanged.

**Tech Stack:** Next.js 16 (App Router), Auth.js v5 (JWT sessions), Prisma 6 (Postgres **and** SQLite), zod 4, bcryptjs, nodemailer, next-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-password-reset-design.md`

**Base:** branch `feat/password-reset`, cut from `feat/change-password` (PR #89). Everything that PR built is available and must not be re-created: `User.passwordChangedAt`, `lib/session-freshness.ts`, `lib/password.ts`, the `jwt` callback check, `PUT /api/account/password`.

## Global Constraints

- **Both database providers.** `prisma/schema.prisma` is committed with `provider = "postgresql"`; every change must also push on SQLite. No Prisma `enum`, no `@db.*`, no native arrays/JSON. `npm run db:push`, never `prisma migrate`.
- **No committed migrations**, so a required column without a default would offer to reset data. The new column is nullable.
- **Three locales, always:** `messages/de.json`, `messages/en.json`, `messages/it.json`. DE is the default and uses informal *du*.
- **Reuse existing message keys.** `errors.passwordMin`, `errors.invalidRequest`, `auth.verifyNoToken` already exist. Do not add second wordings.
- **Never write `passwordHash: null`.** `lib/admin-users.test.ts` asserts exactly one file does, inside a `create`.
- **Never touch `termsAcceptedAt` / `termsVersion`.** Recovering a password is not a new consent.
- **The request endpoint's response must never vary.** Same status, same body, for unknown, banned, password-less, rate-limited and successful requests alike.
- **Gates:** `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` all pass. `npm run lint` reports 5 pre-existing warnings in `components/PuzzleBoard.tsx` (issue #87) — warnings, exit 0, not this work's business.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/roles.ts` (modify) | add `PASSWORD_RESET` to `TOKEN_TYPES` |
| `lib/token-ttl.ts` (modify) | add the kind and its 2 h TTL |
| `prisma/schema.prisma` (modify) | `VerificationToken.requesterIpHash String?` + index |
| `lib/password-reset.ts` (create) | rate-limit constants and the in-process probe counter |
| `lib/password-reset.test.ts` (create) | its tests |
| `lib/mail.ts` (modify) | `resetUrl`, `sendPasswordResetEmail` |
| `app/api/account/password/reset-request/route.ts` (create) | public request endpoint |
| `app/api/account/password/reset/route.ts` (create) | completion endpoint |
| `app/api/account/password/route.ts` (modify) | revoke reset tokens on a deliberate change |
| `app/[locale]/forgot/page.tsx` (create) | ask for the address |
| `app/[locale]/reset/page.tsx` (create) | set the new password |
| `app/[locale]/login/page.tsx` (modify) | link to `/forgot` |
| `messages/{de,en,it}.json` (modify) | mail copy, page copy |
| `CHANGELOG.md` (modify) | `## [Unreleased]` bullet |

---

### Task 1: The `PASSWORD_RESET` token kind

**Files:**
- Modify: `lib/roles.ts:8`
- Modify: `lib/token-ttl.ts:3,7-10`
- Modify: `lib/accounts.test.ts` (the `token-ttl` describe block)

**Interfaces:**
- Consumes: nothing
- Produces: `"PASSWORD_RESET"` as a member of `TokenKind` and `TOKEN_TYPES`; `TOKEN_TTL_MS.PASSWORD_RESET === 2 * 60 * 60 * 1000`

- [ ] **Step 1: Write the failing test**

Append to the `token-ttl` tests in `lib/accounts.test.ts`:

```ts
  it("gives a reset link two hours, far less than a verification or an invite", () => {
    // A reset link grants the account outright, where a verify link only
    // confirms an address. It is the most dangerous credential this system
    // mails, so it is the shortest-lived.
    expect(TOKEN_TTL_MS.PASSWORD_RESET).toBe(2 * 60 * 60 * 1000);
    expect(TOKEN_TTL_MS.PASSWORD_RESET).toBeLessThan(TOKEN_TTL_MS.EMAIL_VERIFY);
    expect(TOKEN_TTL_MS.INVITE).toBeGreaterThan(TOKEN_TTL_MS.EMAIL_VERIFY);
  });

  it("expires a reset token two hours after it was made", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(tokenExpiry("PASSWORD_RESET", now).toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });
```

Add `TOKEN_TTL_MS` to that file's existing import from `./token-ttl` if it is not already there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/accounts.test.ts`
Expected: FAIL — TypeScript rejects `"PASSWORD_RESET"`, which is not a `TokenKind`.

- [ ] **Step 3: Declare the kind in both places**

`lib/roles.ts` — SQLite has no enums, so this union is where token types are declared:

```ts
export const TOKEN_TYPES = ["EMAIL_VERIFY", "INVITE", "PASSWORD_RESET"] as const;
```

`lib/token-ttl.ts`:

```ts
export type TokenKind = "EMAIL_VERIFY" | "INVITE" | "PASSWORD_RESET";

const HOUR = 60 * 60 * 1000;
export const TOKEN_TTL_MS: Record<TokenKind, number> = {
  EMAIL_VERIFY: 24 * HOUR,
  // A reset link grants the account outright, unlike a verify link that only
  // confirms an address — so it is the shortest-lived credential here. Two
  // hours rather than one buys tolerance for a greylisting delay or a slow
  // relay; asking for another is one click either way.
  PASSWORD_RESET: 2 * HOUR,
  INVITE: 7 * 24 * HOUR,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/accounts.test.ts`
Expected: PASS

- [ ] **Step 5: Prove the sweep already covers the new kind**

Both `lib/retention.ts` and `scripts/purge-expired.mjs` delete on `expiresAt` with no type filter, so nothing new is needed. Confirm rather than assume:

Run: `grep -n "deleteMany" -A2 lib/retention.ts scripts/purge-expired.mjs`
Expected: neither `where` clause mentions `type`.

- [ ] **Step 6: Commit**

```bash
git add lib/roles.ts lib/token-ttl.ts lib/accounts.test.ts
git commit -m "feat(tokens): add the PASSWORD_RESET kind, two hours"
```

---

### Task 2: `requesterIpHash` on the token table

**Files:**
- Modify: `prisma/schema.prisma` (the `VerificationToken` model)

**Interfaces:**
- Consumes: nothing
- Produces: `VerificationToken.requesterIpHash: string | null`, indexed

- [ ] **Step 1: Add the column and its index**

Inside `model VerificationToken`, after `createdAt`:

```prisma
  // Hashed with hashReporterIp, exactly as Report.reporterIpHash is, so the
  // reset-request endpoint can rate-limit per IP by counting rows. Null for
  // tokens not created from a request (verification, invites) and for every row
  // that predates the column.
  requesterIpHash String?
```

and beside the existing `@@index([userId])`:

```prisma
  @@index([requesterIpHash])
```

- [ ] **Step 2: Regenerate the client**

Run: `npm run db:generate`
Expected: `✔ Generated Prisma Client`

- [ ] **Step 3: Push on both providers**

There is no `.env` in this worktree, and the dev container serves a different checkout. Use throwaway databases for both, so no real data is touched:

```bash
DATABASE_PROVIDER=sqlite DATABASE_URL="file:./dev-sqlite-check.db" npm run db:push
```

For Postgres, if no server is reachable, report that step as **not run** rather than inventing a result — the SQLite push plus `npx tsc --noEmit` already prove the schema is valid, and CI builds both images. Do not start containers.

Delete any throwaway `.db` file afterwards. Note the relative `file:` URL resolves against the schema's directory, so the file appears under `prisma/`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): record the requesting IP hash on a token"
```

---

### Task 3: Rate-limit constants and the probe counter

**Files:**
- Create: `lib/password-reset.ts`
- Create: `lib/password-reset.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `RESET_PER_EMAIL_LIMIT`, `RESET_PER_IP_LIMIT`, `RESET_RATE_WINDOW_MS`, `PROBE_LIMIT`, `PROBE_WINDOW_MS`, and `recordProbe(ipHash: string, now?: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `lib/password-reset.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  PROBE_LIMIT,
  PROBE_WINDOW_MS,
  RESET_PER_EMAIL_LIMIT,
  RESET_PER_IP_LIMIT,
  RESET_RATE_WINDOW_MS,
  recordProbe,
  __resetProbeState,
} from "./password-reset";

beforeEach(() => __resetProbeState());

describe("the limits", () => {
  it("allows fewer resets per address than per IP", () => {
    // One person recovering their own account needs very few; one office behind
    // one address may legitimately have several people.
    expect(RESET_PER_EMAIL_LIMIT).toBeLessThan(RESET_PER_IP_LIMIT);
  });

  it("uses a window long enough to be worth counting", () => {
    expect(RESET_RATE_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(PROBE_WINDOW_MS).toBeLessThanOrEqual(RESET_RATE_WINDOW_MS);
  });
});

describe("recordProbe", () => {
  it("allows callers up to the limit and refuses the one after", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) {
      expect(recordProbe("ip-a", 1_000)).toBe(true);
    }
    expect(recordProbe("ip-a", 1_000)).toBe(false);
  });

  it("counts each caller separately", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) recordProbe("ip-a", 1_000);
    // ip-a is spent; ip-b must be unaffected.
    expect(recordProbe("ip-b", 1_000)).toBe(true);
  });

  it("forgets attempts once the window has passed", () => {
    for (let i = 0; i < PROBE_LIMIT; i++) recordProbe("ip-a", 1_000);
    expect(recordProbe("ip-a", 1_000)).toBe(false);
    expect(recordProbe("ip-a", 1_000 + PROBE_WINDOW_MS + 1)).toBe(true);
  });

  it("does not grow without bound as callers come and go", () => {
    // The counter lives in the process for its lifetime; without pruning, every
    // address that ever probed would be retained until restart.
    for (let i = 0; i < 50; i++) recordProbe(`ip-${i}`, 1_000);
    // One much later call must be enough to drop the stale entries.
    recordProbe("ip-new", 1_000 + PROBE_WINDOW_MS * 10);
    expect(__resetProbeState.size()).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/password-reset.test.ts`
Expected: FAIL — `Failed to resolve import "./password-reset"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/password-reset.ts`:

```ts
// Rate limiting for password reset, in two halves that defend different things.
//
// The durable half lives in the database: the request route counts recent
// PASSWORD_RESET rows per user and per requesting IP, the same shape
// app/api/report/route.ts uses for reports. That caps mail actually sent to
// real people, survives a restart, and works across replicas.
//
// This file is the other half. The durable count cannot see a request for an
// address that does not exist, because such a request creates no row — so
// somebody enumerating addresses would be counted zero times. `recordProbe`
// counts *every* request, including the ones that produce nothing.
//
// It is in-process on purpose. Losing it on restart, and its being per-replica,
// are acceptable because it guards work rather than secrets: the request
// endpoint answers identically whatever happens, so probing learns nothing
// either way. This only stops it being free.

/** Per account, per window. One person recovering one account needs very few. */
export const RESET_PER_EMAIL_LIMIT = 3;

/** Per requesting IP, per window — an office may hold several real people. */
export const RESET_PER_IP_LIMIT = 10;

export const RESET_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Every request from one IP, existing address or not. */
export const PROBE_LIMIT = 20;
export const PROBE_WINDOW_MS = 10 * 60 * 1000;

/** ipHash -> timestamps within the current window. */
const probes = new Map<string, number[]>();

/**
 * Record one request from `ipHash` and say whether it is allowed.
 *
 * Prunes as it goes: without that, every address that ever probed would be held
 * until the process restarted.
 */
export function recordProbe(ipHash: string, now: number = Date.now()): boolean {
  const cutoff = now - PROBE_WINDOW_MS;

  for (const [key, times] of probes) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) probes.delete(key);
    else probes.set(key, live);
  }

  const mine = probes.get(ipHash) ?? [];
  if (mine.length >= PROBE_LIMIT) return false;
  mine.push(now);
  probes.set(ipHash, mine);
  return true;
}

/** Test seam: the counter is module state, so tests need a way to clear it. */
export function __resetProbeState(): void {
  probes.clear();
}
__resetProbeState.size = () => probes.size;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/password-reset.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/password-reset.ts lib/password-reset.test.ts
git commit -m "feat(reset): rate-limit constants and the probe counter"
```

---

### Task 4: The reset mail

**Files:**
- Modify: `lib/mail.ts` (beside `verifyUrl` / `sendVerificationEmail`)
- Modify: `messages/de.json`, `messages/en.json`, `messages/it.json` (the `email` object)
- Modify: `lib/mail.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `resetUrl(token: string, locale: Locale): string`, `sendPasswordResetEmail(to: string, token: string, locale?: string): Promise<void>`

- [ ] **Step 1: Add the copy, all three locales**

Inside the `"email"` object, after the `invite*` keys.

`messages/en.json`:

```json
    "resetSubject": "Reset your password",
    "resetIntro": "Someone asked to reset the password for this address.",
    "resetAction": "Open this link to choose a new password:",
    "resetExpiry": "The link works for two hours. If you did not ask for it, you can ignore this email — nothing has changed."
```

`messages/de.json`:

```json
    "resetSubject": "Passwort zurücksetzen",
    "resetIntro": "Für diese Adresse wurde ein neues Passwort angefordert.",
    "resetAction": "Öffne diesen Link, um ein neues Passwort zu wählen:",
    "resetExpiry": "Der Link gilt zwei Stunden. Wenn du das nicht warst, kannst du diese E-Mail ignorieren — es hat sich nichts geändert."
```

`messages/it.json`:

```json
    "resetSubject": "Reimposta la password",
    "resetIntro": "Qualcuno ha richiesto di reimpostare la password per questo indirizzo.",
    "resetAction": "Apri questo link per scegliere una nuova password:",
    "resetExpiry": "Il link è valido per due ore. Se non sei stato tu, puoi ignorare questa email — non è cambiato nulla."
```

Note the deliberate wording: the mail never says whether an account exists, and it tells an unintended recipient that ignoring it is safe.

- [ ] **Step 2: Write the failing test**

Append to `lib/mail.test.ts`, following the existing verification-mail tests in that file:

```ts
  it("sends a reset link on the recipient's locale prefix", async () => {
    await sendPasswordResetEmail("someone@example.com", "tok-123", "it");
    const sent = sendMailMock.mock.calls[0][0];

    expect(sent.to).toBe("someone@example.com");
    expect(sent.text).toContain("/it/reset?token=tok-123");
    expect(sent.html).toContain("/it/reset?token=tok-123");
  });

  it("never states whether the address has an account", async () => {
    // The request endpoint answers identically for unknown addresses; a mail
    // that said "your account" would give away what the endpoint withholds —
    // to anyone who can read the recipient's inbox.
    await sendPasswordResetEmail("someone@example.com", "tok-123", "en");
    const sent = sendMailMock.mock.calls[0][0];

    expect(sent.text).toContain("Someone asked to reset the password");
    expect(sent.text).toContain("you can ignore this email");
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/mail.test.ts`
Expected: FAIL — `sendPasswordResetEmail` is not exported.

- [ ] **Step 4: Write minimal implementation**

In `lib/mail.ts`, beside `inviteUrl`:

```ts
export function resetUrl(token: string, locale: Locale): string {
  return `${appUrl()}/${locale}/reset?token=${encodeURIComponent(token)}`;
}
```

and beside `sendInviteEmail`:

```ts
export async function sendPasswordResetEmail(
  to: string,
  token: string,
  locale?: string,
): Promise<void> {
  const loc = resolveLocale(locale);
  const t = await getTranslations({ locale: loc, namespace: "email" });
  const url = resetUrl(token, loc);
  await transport().sendMail({
    from: FROM,
    to,
    subject: t("resetSubject"),
    text: `${t("resetIntro")}\n\n${t("resetAction")}\n${url}\n\n${t("resetExpiry")}`,
    html: `<p>${t("resetIntro")}</p><p>${t("resetAction")}</p><p><a href="${url}">${url}</a></p><p>${t("resetExpiry")}</p>`,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/mail.test.ts`
Expected: PASS

- [ ] **Step 6: Prove catalogue parity**

Run:
```bash
node -e "const de=require('./messages/de.json'),en=require('./messages/en.json'),it=require('./messages/it.json');const k=(o,p='')=>Object.entries(o).flatMap(([a,b])=>typeof b==='object'&&b!==null?k(b,p+a+'.'):[p+a]);const[d,e,i]=[k(de),k(en),k(it)].map(x=>x.sort());console.log(d.length,e.length,i.length);console.log(e.filter(x=>!d.includes(x)),e.filter(x=>!i.includes(x)),d.filter(x=>!e.includes(x)))"
```
Expected: three equal counts and three empty arrays.

- [ ] **Step 7: Commit**

```bash
git add lib/mail.ts lib/mail.test.ts messages/de.json messages/en.json messages/it.json
git commit -m "feat(mail): send a password reset link"
```

---

### Task 5: `POST /api/account/password/reset-request`

**Files:**
- Create: `app/api/account/password/reset-request/route.ts`
- Create: `app/api/account/password/reset-request/route.test.ts`

**Interfaces:**
- Consumes: `recordProbe`, `RESET_PER_EMAIL_LIMIT`, `RESET_PER_IP_LIMIT`, `RESET_RATE_WINDOW_MS` (Task 3); `sendPasswordResetEmail` (Task 4); `PASSWORD_RESET` (Task 1); `requesterIpHash` (Task 2)
- Produces: a `POST` handler that always answers `200 { ok: true }`

- [ ] **Step 1: Write the failing test**

Create `app/api/account/password/reset-request/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/account/password/reset-request/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Write minimal implementation**

Create `app/api/account/password/reset-request/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/bans";
import { checkEmailBanned } from "@/lib/moderation";
import { createToken } from "@/lib/tokens";
import { sendPasswordResetEmail } from "@/lib/mail";
import { hashReporterIp } from "@/lib/report-ip";
import { resolveRequestLocale } from "@/lib/i18n-server";
import {
  RESET_PER_EMAIL_LIMIT,
  RESET_PER_IP_LIMIT,
  RESET_RATE_WINDOW_MS,
  recordProbe,
} from "@/lib/password-reset";

const Schema = z.object({ email: z.string().email() });

/**
 * The one answer this route ever gives. Unknown address, banned address, a row
 * with no password, a spent rate limit, a malformed body and a sent mail all
 * produce exactly this — which is what lets the endpoint be public without
 * telling the internet which addresses have accounts.
 */
const SAME_ANSWER = { ok: true };
const answer = () => NextResponse.json(SAME_ANSWER);

export async function POST(request: Request) {
  const ipHash = hashReporterIp(request.headers.get("x-forwarded-for"));

  // Before anything that costs a query. This is the only limit that sees a
  // request for an address with no account, because such a request creates no
  // row for the database counts below to find.
  if (!recordProbe(ipHash)) return answer();

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return answer();

  const email = normalizeEmail(parsed.data.email);
  if (await checkEmailBanned(email)) return answer();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true },
  });

  // A row with no hash is an invitation that was never redeemed; those belong to
  // the invite flow (#33), and a reset link would be a second, quieter way to
  // activate one. Verification is deliberately NOT required — an account that
  // never confirmed its address is exactly the one with no other way back, and
  // completing the reset marks it verified.
  if (!user?.passwordHash) return answer();

  const since = new Date(Date.now() - RESET_RATE_WINDOW_MS);
  const [forUser, forIp] = await Promise.all([
    prisma.verificationToken.count({
      where: { userId: user.id, type: "PASSWORD_RESET", createdAt: { gte: since } },
    }),
    prisma.verificationToken.count({
      where: { requesterIpHash: ipHash, type: "PASSWORD_RESET", createdAt: { gte: since } },
    }),
  ]);
  if (forUser >= RESET_PER_EMAIL_LIMIT || forIp >= RESET_PER_IP_LIMIT) return answer();

  // Deliberately no revokeTokens here, unlike the admin invite route. Revoking
  // deletes the rows the counts above read, so the per-address limit could never
  // exceed one. The invite route's reasoning does not transfer either: its two
  // live links can sit in two different mailboxes, where every reset link goes
  // to the account's own address. Single use and a two-hour life are what keep
  // the extras harmless.
  const locale = await resolveRequestLocale();
  const token = await createToken(user.id, "PASSWORD_RESET", ipHash);
  await sendPasswordResetEmail(user.email, token, locale);

  return answer();
}
```

- [ ] **Step 4: Extend `createToken` to record the hash**

`lib/tokens.ts`'s `createToken` needs a third, optional argument. Change its signature and the `create` call:

```ts
export async function createToken(
  userId: string,
  type: TokenKind,
  requesterIpHash: string | null = null,
): Promise<string> {
```

and include `requesterIpHash` in the `data` it writes. Existing callers pass two arguments and keep working, storing null.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/api/account/password/reset-request/route.test.ts lib/tokens.test.ts`
Expected: PASS, including the existing token tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add app/api/account/password/reset-request lib/tokens.ts
git commit -m "feat(account): add the password reset request endpoint"
```

---

### Task 6: `POST /api/account/password/reset`

**Files:**
- Create: `app/api/account/password/reset/route.ts`
- Create: `app/api/account/password/reset/route.test.ts`

**Interfaces:**
- Consumes: `consumeToken` from `@/lib/tokens`; `passwordField` from `@/lib/password`
- Produces: a `POST` handler answering `200 { ok: true }` or a 400 with a translated error

- [ ] **Step 1: Write the failing test**

Create `app/api/account/password/reset/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { consumeTokenMock, userUpdate, hashMock } = vi.hoisted(() => ({
  consumeTokenMock: vi.fn(),
  userUpdate: vi.fn(),
  hashMock: vi.fn(),
}));

vi.mock("@/lib/tokens", () => ({ consumeToken: consumeTokenMock }));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: userUpdate } } }));
vi.mock("bcryptjs", () => ({ default: { hash: hashMock } }));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));

import { POST } from "./route";

function call(body: unknown) {
  return POST(
    new Request("http://test/api/account/password/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { token: "tok-123", password: "brandnewpass" };

describe("POST /api/account/password/reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeTokenMock.mockResolvedValue({ ok: true, userId: "u1" });
    hashMock.mockResolvedValue("$2b$new");
    userUpdate.mockResolvedValue({});
  });

  it("sets the new password when the link is good", async () => {
    const res = await call(VALID);
    expect(res.status).toBe(200);
    expect(consumeTokenMock).toHaveBeenCalledWith("tok-123", "PASSWORD_RESET");
  });

  it("writes the hash, the stamp and the verification in one update", async () => {
    // The stamp is what ends every other session; the verification is because
    // clicking a link sent to the address proves the same thing the
    // confirmation mail asks.
    await call(VALID);
    const data = userUpdate.mock.calls[0][0].data;

    expect(data.passwordHash).toBe("$2b$new");
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
    expect(data.emailVerified).toBeInstanceOf(Date);
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it("never clears a hash, and never touches consent", async () => {
    await call(VALID);
    const data = userUpdate.mock.calls[0][0].data;
    expect(data.passwordHash).not.toBeNull();
    expect(data).not.toHaveProperty("termsAcceptedAt");
    expect(data).not.toHaveProperty("termsVersion");
  });

  it("refuses an expired, foreign or already-used link", async () => {
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "invalid" });
    const res = await call(VALID);
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("says so plainly when the token store itself is unavailable", async () => {
    // consumeToken distinguishes "no such link" from "could not check" so the
    // user is not told their valid link is invalid.
    consumeTokenMock.mockResolvedValue({ ok: false, reason: "unavailable" });
    const res = await call(VALID);
    expect(res.status).toBe(503);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a password under the minimum without spending the link", async () => {
    const res = await call({ token: "tok-123", password: "short" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passwordMin" });
    expect(consumeTokenMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/account/password/reset/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Check how the invite route maps a refusal, then write the implementation**

Read `app/api/invite/route.ts` first: it already consumes a token and maps `ClaimRefusal` to a response. Mirror it.

Create `app/api/account/password/reset/route.ts`:

```ts
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { consumeToken } from "@/lib/tokens";
import { passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({ token: z.string().min(1), password: passwordField });

export async function POST(request: Request) {
  const t = await getErrorT();

  // Validated before the token is spent: a too-short password must not burn a
  // single-use link and leave the user to request another.
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const onPassword = parsed.error.issues.some((i) => i.path.includes("password"));
    return NextResponse.json(
      { error: t(onPassword ? "passwordMin" : "invalidRequest") },
      { status: 400 },
    );
  }

  const claim = await consumeToken(parsed.data.token, "PASSWORD_RESET");
  if (!claim.ok) {
    // "unavailable" means the store could not be read, not that the link is
    // bad — telling the user their valid link is invalid would send them round
    // the request loop for nothing.
    return claim.reason === "unavailable"
      ? NextResponse.json({ error: t("linkUnavailable") }, { status: 503 })
      : NextResponse.json({ error: t("inviteFailed") }, { status: 400 });
  }

  const now = new Date();
  await prisma.user.update({
    where: { id: claim.userId },
    data: {
      passwordHash: await bcrypt.hash(parsed.data.password, 10),
      // Ends every other session: the jwt callback refuses any token issued at
      // or before this second (lib/session-freshness.ts).
      passwordChangedAt: now,
      // Clicking a link sent to the address proves what the confirmation mail
      // asks, so a reset doubles as verification. See the design doc.
      emailVerified: now,
    },
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Confirm the error keys exist**

All four are already in all three catalogues — `errors.passwordMin`,
`errors.invalidRequest`, `errors.inviteFailed` and `errors.linkUnavailable`. The
last is the one `app/api/invite/route.ts:24` already uses for exactly this
`unavailable` branch, with the same 503; reuse it rather than adding a second
wording.

Run: `node -e "const m=require('./messages/en.json'); for (const k of ['passwordMin','invalidRequest','inviteFailed','linkUnavailable']) console.log(k, k in m.errors)"`
Expected: four `true`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/api/account/password/reset/route.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add app/api/account/password/reset
git commit -m "feat(account): add the password reset completion endpoint"
```

---

### Task 7: A deliberate change kills outstanding reset links

**Files:**
- Modify: `app/api/account/password/route.ts`
- Modify: `app/api/account/password/route.test.ts`

**Interfaces:**
- Consumes: `revokeTokens` from `@/lib/tokens`; `PASSWORD_RESET` (Task 1)
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

Add to `app/api/account/password/route.test.ts`, and add `revokeTokensMock` to the `vi.hoisted` block plus `vi.mock("@/lib/tokens", () => ({ revokeTokens: revokeTokensMock }))`:

```ts
  it("kills any outstanding reset links", async () => {
    // Someone who changes their password deliberately has answered whatever
    // prompted an earlier "I forgot" — leaving that mail live would leave a
    // second key to the account sitting in an inbox.
    await call(VALID);
    expect(revokeTokensMock).toHaveBeenCalledWith("u1", "PASSWORD_RESET");
  });

  it("does not kill them when the change is refused", async () => {
    compareMock.mockResolvedValue(false);
    await call(VALID);
    expect(revokeTokensMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/account/password/route.test.ts`
Expected: FAIL — `revokeTokensMock` was never called.

- [ ] **Step 3: Write minimal implementation**

In `app/api/account/password/route.ts`, import `revokeTokens` from `@/lib/tokens` and call it after the successful update:

```ts
  // A reset mail still sitting in an inbox is a second key. Changing the
  // password deliberately answers whatever prompted it, so the link goes.
  // After the update, not before: a failed write must not disarm a link the
  // user may still need.
  await revokeTokens(user.id, "PASSWORD_RESET");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/account/password/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/account/password/route.ts app/api/account/password/route.test.ts
git commit -m "feat(account): revoke reset links when the password is changed"
```

---

### Task 8: The two pages and the link to them

**Files:**
- Create: `app/[locale]/forgot/page.tsx`, `app/[locale]/forgot/page.client.test.tsx`
- Create: `app/[locale]/reset/page.tsx`, `app/[locale]/reset/page.client.test.tsx`
- Modify: `app/[locale]/login/page.tsx`
- Modify: `messages/{de,en,it}.json` (the `auth` object)

**Interfaces:**
- Consumes: the two routes from Tasks 5 and 6
- Produces: nothing other tasks import

- [ ] **Step 1: Add the copy, all three locales**

Inside `"auth"`, after `passwordChangedSignIn`.

`messages/en.json`:

```json
    "forgotLink": "Forgot your password?",
    "forgotTitle": "Reset your password",
    "forgotIntro": "Enter your email address and we will send you a link to choose a new password.",
    "forgotSubmit": "Send the link",
    "forgotSending": "Sending…",
    "forgotDone": "If an account exists for that address, a link is on its way. Check your inbox.",
    "forgotFailed": "The request could not be sent.",
    "resetTitle": "Choose a new password",
    "resetSubmit": "Set password",
    "resetSaving": "Saving…",
    "resetDone": "Your password is set. You can sign in now.",
    "resetFailed": "The password could not be set. The link may have expired."
```

`messages/de.json`:

```json
    "forgotLink": "Passwort vergessen?",
    "forgotTitle": "Passwort zurücksetzen",
    "forgotIntro": "Gib deine E-Mail-Adresse ein, dann schicken wir dir einen Link für ein neues Passwort.",
    "forgotSubmit": "Link senden",
    "forgotSending": "Wird gesendet…",
    "forgotDone": "Falls es ein Konto für diese Adresse gibt, ist ein Link unterwegs. Schau in dein Postfach.",
    "forgotFailed": "Die Anfrage konnte nicht gesendet werden.",
    "resetTitle": "Neues Passwort wählen",
    "resetSubmit": "Passwort setzen",
    "resetSaving": "Wird gespeichert…",
    "resetDone": "Dein Passwort ist gesetzt. Du kannst dich jetzt anmelden.",
    "resetFailed": "Das Passwort konnte nicht gesetzt werden. Der Link ist vielleicht abgelaufen."
```

`messages/it.json`:

```json
    "forgotLink": "Password dimenticata?",
    "forgotTitle": "Reimposta la password",
    "forgotIntro": "Inserisci il tuo indirizzo email e ti invieremo un link per scegliere una nuova password.",
    "forgotSubmit": "Invia il link",
    "forgotSending": "Invio in corso…",
    "forgotDone": "Se esiste un account per questo indirizzo, il link è in arrivo. Controlla la tua casella.",
    "forgotFailed": "Non è stato possibile inviare la richiesta.",
    "resetTitle": "Scegli una nuova password",
    "resetSubmit": "Imposta password",
    "resetSaving": "Salvataggio…",
    "resetDone": "La tua password è impostata. Ora puoi accedere.",
    "resetFailed": "Non è stato possibile impostare la password. Il link potrebbe essere scaduto."
```

`forgotDone` is worded to match the endpoint: it says *if* an account exists, because the page must not reveal more than the route does.

- [ ] **Step 2: Write the failing tests**

Create `app/[locale]/forgot/page.client.test.tsx`. Model it on `app/[locale]/verify/page.client.test.tsx`, which already exists and shows the mocking and `createRoot`/`act` shape for a client page under `app/`. The file must use the `.client.test.tsx` suffix so it lands in the jsdom `pages-client` vitest project rather than the node `pages` one.

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ForgotPage from "./page";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ForgotPage />
      </NextIntlClientProvider>,
    );
  });
}

/** React's controlled-input tracker absorbs a plain `.value =` assignment. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(email: string) {
  const input = container.querySelector<HTMLInputElement>("input[type=email]")!;
  await act(async () => setValue(input, email));
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const text = () => container.textContent ?? "";

describe("ForgotPage", () => {
  it("posts the address to the request endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await submit("someone@example.com");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/password/reset-request",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "someone@example.com" }) }),
    );
  });

  it("shows the same confirmation whatever the address was", async () => {
    // The page must not reveal more than the endpoint does.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    mount();
    await submit("nobody@example.com");

    expect(text()).toContain(messages.auth.forgotDone);
  });

  it("reports a failed request without claiming a link was sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    mount();
    await submit("someone@example.com");

    expect(text()).toContain(messages.auth.forgotFailed);
    expect(text()).not.toContain(messages.auth.forgotDone);
  });
});
```

Create `app/[locale]/reset/page.client.test.tsx` in the same shape, mocking `next/navigation`'s `useSearchParams` as `app/[locale]/verify/page.client.test.tsx` does, and covering: a missing token shows `auth.verifyNoToken` without calling fetch; a good token posts `{ token, password }` to `/api/account/password/reset` and then shows `auth.resetDone`; a refusal shows `auth.resetFailed`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run "app/[locale]/forgot" "app/[locale]/reset"`
Expected: FAIL — neither page exists.

- [ ] **Step 4: Write the pages**

Both are `"use client"`. `app/[locale]/forgot/page.tsx` holds an email input, posts to `/api/account/password/reset-request`, and on any 2xx shows `auth.forgotDone` — it must not branch on anything the response says, because the response says the same thing every time. On a thrown request it shows `auth.forgotFailed`.

`app/[locale]/reset/page.tsx` reads `token` from `useSearchParams`, shows `auth.verifyNoToken` when absent, otherwise takes a password with `minLength={PASSWORD_MIN_LENGTH}` from `@/lib/password`, posts `{ token, password }`, and shows `auth.resetDone` with a link to `/login` on success or the server's `error` (falling back to `auth.resetFailed`) otherwise.

Follow `app/[locale]/invite/page.tsx` for structure — it is the closest existing page: a token from the URL, a password, a done state.

- [ ] **Step 5: Link it from the login form**

In `app/[locale]/login/page.tsx`, beside the existing "No account yet?" line:

```tsx
      <p>
        <Link href="/forgot">{t("forgotLink")}</Link>
      </p>
```

- [ ] **Step 6: Run tests and the parity check**

Run: `npx vitest run` and the catalogue parity one-liner from Task 4 Step 6.
Expected: all pass; three equal counts, three empty arrays.

- [ ] **Step 7: Commit**

```bash
git add "app/[locale]/forgot" "app/[locale]/reset" "app/[locale]/login/page.tsx" messages/de.json messages/en.json messages/it.json
git commit -m "feat(auth): add the forgot and reset pages"
```

---

### Task 9: Changelog and the gates

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the entry**

Under `## [Unreleased]` → `### Added`, after the password-change bullet already there:

```markdown
- Forgotten a password? **Forgot your password?** on the sign-in page mails a
  link that sets a new one. The link works once and for two hours, and the page
  answers the same way whether or not an address has an account, so it cannot be
  used to find out who is registered. Completing a reset signs you out
  everywhere else, and confirms your email address if it was still unconfirmed.
  (#42)
```

- [ ] **Step 2: Run every gate**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```
Expected: all four exit 0. `npm run lint` still reports the 5 `PuzzleBoard` warnings from #87.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for password reset by email"
```

---

## Notes for the reviewer

- **The request endpoint's single answer is the feature's security property.** Any branch that returns something else — a different status, a different body, an early return that skips the shared helper — breaks it. `assertSameAnswer` in its test exists to make that hard to do by accident.
- **No `revokeTokens` in the request route, deliberately.** It would delete the rows the rate limit counts, and the invite route's two-mailboxes reasoning does not transfer. The design doc explains it; the comment in the route repeats it.
- **The probe counter is in-process.** Per-replica and lost on restart, accepted because it guards work rather than secrets.
- **Browser verification is not in this plan.** This branch lives in a worktree that the dev container does not serve. It should be done before merge, against the two-profile pattern used for the password change: request a reset, follow the link, confirm the old password fails, a second session is signed out, and the address is verified afterwards.
