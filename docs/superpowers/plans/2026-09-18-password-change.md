# Self-service password change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A logged-in user can change their own password, and doing so ends every other session.

**Architecture:** A nullable `User.passwordChangedAt` column is stamped on every password write. The Auth.js `jwt` callback compares the token's `iat` against it and returns `null` for anything older, which ends that session. A `PUT /api/account/password` route re-authenticates with bcrypt exactly as the account-deletion route does, and a `ChangePassword` component on `/my` signs the user out on success.

**Tech Stack:** Next.js 16 (App Router), Auth.js v5 (JWT sessions), Prisma 6 (Postgres **and** SQLite), zod 4, bcryptjs, next-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-password-change-design.md`

## Global Constraints

- **Both database providers.** `prisma/schema.prisma` is committed with `provider = "postgresql"`; every change must also push on SQLite. No Prisma `enum`, no `@db.*` native attributes, no native arrays/JSON. Push with `npm run db:push`, never `prisma migrate`.
- **No committed migrations.** `db push` is the mechanism, so a required column without a default would offer to reset existing data. The new column is nullable.
- **Three locales, always.** Any user-facing string needs `messages/de.json`, `messages/en.json` *and* `messages/it.json`. DE is the default.
- **Reuse existing message keys.** `errors.wrongPassword` and `errors.passwordMin` already exist in all three locales. Do not add second wordings.
- **Never touch `termsAcceptedAt` / `termsVersion`.** A password change is not a new consent.
- **Never write `passwordHash: null`.** `lib/admin-users.test.ts` asserts that only `app/api/admin/users/invite/route.ts` does, inside a `create`. This feature sets a hash; it never clears one.
- **Gates:** `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` must all pass before the final commit.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/password.ts` (create) | The one definition of the password rule (min 8) |
| `lib/password.test.ts` (create) | Its tests |
| `lib/signup.ts` (modify) | Stop spelling `z.string().min(8)` twice; use the shared field |
| `lib/session-freshness.ts` (create) | Pure `isSessionStale(iat, changedAt)` — no DB, no session |
| `lib/session-freshness.test.ts` (create) | Its tests, including the second boundary |
| `prisma/schema.prisma` (modify) | `passwordChangedAt DateTime?` on `User` |
| `lib/auth.ts` (modify) | `jwt` callback returns `null` for a stale token |
| `app/api/account/password/route.ts` (create) | `PUT` — re-authenticate, hash, stamp |
| `app/api/account/password/route.test.ts` (create) | Its branches |
| `messages/{de,en,it}.json` (modify) | Form copy and the `/login` notice |
| `components/ChangePassword.tsx` (create) | The form, beside `DeleteAccount` |
| `components/ChangePassword.test.tsx` (create) | Its tests |
| `app/[locale]/my/page.tsx` (modify) | Mount the component |
| `app/[locale]/login/page.tsx` (modify) | Show the notice on `?changed=1` |
| `CHANGELOG.md` (modify) | `## [Unreleased]` bullet |

---

### Task 1: One definition of the password rule

**Files:**
- Create: `lib/password.ts`
- Create: `lib/password.test.ts`
- Modify: `lib/signup.ts:16,24`

**Interfaces:**
- Consumes: nothing
- Produces: `passwordField: z.ZodString` and `PASSWORD_MIN_LENGTH: 8` from `lib/password.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/password.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { passwordField, PASSWORD_MIN_LENGTH } from "./password";

describe("passwordField", () => {
  it("states the minimum once, as a number others can quote", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it("rejects anything under the minimum", () => {
    expect(passwordField.safeParse("1234567").success).toBe(false);
    expect(passwordField.safeParse("").success).toBe(false);
  });

  it("accepts the minimum and above", () => {
    expect(passwordField.safeParse("12345678").success).toBe(true);
    expect(passwordField.safeParse("a".repeat(200)).success).toBe(true);
  });

  it("rejects a non-string, so a JSON body cannot smuggle one past", () => {
    expect(passwordField.safeParse(12345678).success).toBe(false);
    expect(passwordField.safeParse(null).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/password.test.ts`
Expected: FAIL — `Failed to resolve import "./password"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/password.ts`:

```ts
import { z } from "zod";

/**
 * The password rule, in one place. Four writers have to agree on it —
 * registration, invite activation, this change endpoint and (later) reset by
 * email — and before this they each spelled `z.string().min(8)` for
 * themselves. `errors.passwordMin` in the message catalogues is the wording
 * that goes with it.
 */
export const PASSWORD_MIN_LENGTH = 8;

export const passwordField = z.string().min(PASSWORD_MIN_LENGTH);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/password.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Point signup at it**

In `lib/signup.ts`, add the import and replace both password fields:

```ts
import { passwordField } from "./password";
```

`RegisterSchema` becomes:

```ts
export const RegisterSchema = z.object({
  email: z.string().email(),
  password: passwordField,
  name: z.string().trim().max(80).optional(),
  termsAccepted,
});
```

`InviteSchema` becomes:

```ts
export const InviteSchema = z.object({
  token: z.string().min(1),
  password: passwordField,
  termsAccepted,
});
```

- [ ] **Step 6: Run the signup tests to prove nothing moved**

Run: `npx vitest run lib/signup.test.ts lib/password.test.ts`
Expected: PASS — the existing signup tests still pass unchanged, including `errorKey(RegisterSchema, { ...REGISTER, password: "short" })` returning `"passwordMin"`.

- [ ] **Step 7: Commit**

```bash
git add lib/password.ts lib/password.test.ts lib/signup.ts
git commit -m "refactor(auth): give the password rule one definition"
```

---

### Task 2: The staleness comparison, as a pure function

**Files:**
- Create: `lib/session-freshness.ts`
- Create: `lib/session-freshness.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `isSessionStale(iatSeconds: number | undefined, changedAt: Date | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `lib/session-freshness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isSessionStale } from "./session-freshness";

/** `iat` is whole seconds since the epoch; a DateTime is milliseconds. */
const at = (seconds: number, ms = 0) => new Date(seconds * 1000 + ms);

describe("isSessionStale", () => {
  it("keeps every session when the password has never changed", () => {
    expect(isSessionStale(1_000, null)).toBe(false);
    expect(isSessionStale(0, null)).toBe(false);
  });

  it("rejects a token issued before the change", () => {
    expect(isSessionStale(1_000, at(1_001))).toBe(true);
  });

  it("keeps a token issued after the change", () => {
    expect(isSessionStale(1_002, at(1_001))).toBe(false);
  });

  it("keeps a token issued in the same second as the change", () => {
    // The deliberate sub-second window. `iat` has no sub-second precision, so
    // the alternative is rejecting the fresh session of someone who signs back
    // in within the same second as their own change. A token issued in that
    // second is not a threat worth that.
    expect(isSessionStale(1_001, at(1_001, 400))).toBe(false);
    expect(isSessionStale(1_001, at(1_001, 999))).toBe(false);
  });

  it("treats a token with no issue time as stale", () => {
    // A token we cannot date is one we cannot vouch for.
    expect(isSessionStale(undefined, at(1_001))).toBe(true);
  });

  it("does not treat an undatable token as stale when nothing has changed", () => {
    expect(isSessionStale(undefined, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/session-freshness.test.ts`
Expected: FAIL — `Failed to resolve import "./session-freshness"`

- [ ] **Step 3: Write minimal implementation**

Create `lib/session-freshness.ts`:

```ts
// Whether a JWT predates the account's last password change. Pure, so the
// boundary is testable without a database or a session — the callback in
// lib/auth.ts is then thin enough to read at a glance.

/**
 * `iatSeconds` is the JWT's `iat` claim (whole seconds); `changedAt` is
 * `User.passwordChangedAt`, null for an account whose password has never
 * changed.
 *
 * The comparison is second-to-second, so a token issued in the same second as
 * the change survives. See the test for why that direction was chosen.
 */
export function isSessionStale(
  iatSeconds: number | undefined,
  changedAt: Date | null,
): boolean {
  if (changedAt === null) return false;
  if (iatSeconds === undefined) return true;
  return iatSeconds < Math.floor(changedAt.getTime() / 1000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/session-freshness.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/session-freshness.ts lib/session-freshness.test.ts
git commit -m "feat(auth): add the session staleness comparison"
```

---

### Task 3: The schema column

**Files:**
- Modify: `prisma/schema.prisma` (the `User` model)

**Interfaces:**
- Consumes: nothing
- Produces: `User.passwordChangedAt: Date | null` on the generated Prisma client

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, inside `model User`, after the `emailVerified` line:

```prisma
  // Stamped on every password write. Sessions issued before it are rejected in
  // the jwt callback (lib/session-freshness.ts). Null for an account whose
  // password has never changed, which is every row that exists today — so the
  // column arriving logs nobody out.
  passwordChangedAt DateTime?
```

Nullable deliberately: there are no migrations, `db push` is the mechanism, and a required column without a default would offer to reset existing data.

- [ ] **Step 2: Regenerate the client**

Run: `npm run db:generate`
Expected: `✔ Generated Prisma Client` — the client lands in `lib/generated/prisma` (gitignored).

- [ ] **Step 3: Push on **both** providers**

Run:
```bash
DATABASE_PROVIDER=postgresql npm run db:push
DATABASE_PROVIDER=sqlite     npm run db:push
```
Expected: both report the database is in sync. SQLite is not optional — `:latest-sqlite` is a released image and CI builds it.

If a database is not reachable locally, run it in the container instead:
```bash
docker compose exec app npm run db:push
```

- [ ] **Step 4: Prove the types moved**

Run: `npx tsc --noEmit`
Expected: exit 0. The generated client is typed, so a typo in the column name surfaces here.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): add User.passwordChangedAt"
```

---

### Task 4: End stale sessions in the jwt callback

**Files:**
- Modify: `lib/auth.ts:55-61` (the `jwt` callback)
- Create: `lib/auth.session.test.ts`

**Interfaces:**
- Consumes: `isSessionStale` from `lib/session-freshness.ts` (Task 2); `User.passwordChangedAt` (Task 3)
- Produces: nothing other tasks import

- [ ] **Step 1: Write the failing test**

The callback is defined inline in the `NextAuth({...})` options, so the test exercises it through the exported config. Create `lib/auth.session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique } = vi.hoisted(() => ({ userFindUnique: vi.fn() }));

vi.mock("./db", () => ({ prisma: { user: { findUnique: userFindUnique } } }));
vi.mock("./moderation", () => ({ checkEmailBanned: vi.fn(async () => false) }));
vi.mock("./admin-emails", () => ({ isAdminEmail: () => false }));

// NextAuth is called for its side effect of building the config; capture the
// options object so the callback can be exercised directly.
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
    userFindUnique.mockResolvedValue({ passwordChangedAt: null });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000 } });
    expect(token).not.toBeNull();
  });

  it("ends a session issued before the password changed", async () => {
    // This is the whole feature: a cookie taken before the change stops working.
    userFindUnique.mockResolvedValue({ passwordChangedAt: new Date(1_001_000) });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000 } });
    expect(token).toBeNull();
  });

  it("keeps a session issued after the password changed", async () => {
    userFindUnique.mockResolvedValue({ passwordChangedAt: new Date(1_001_000) });
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_002 } });
    expect(token).not.toBeNull();
  });

  it("ends a session whose user is gone", async () => {
    userFindUnique.mockResolvedValue(null);
    const token = await jwtCallback()({ token: { id: "u1", iat: 1_000 } });
    expect(token).toBeNull();
  });

  it("passes a token with no id straight through, having nothing to check", async () => {
    const token = await jwtCallback()({ token: { iat: 1_000 } });
    expect(token).not.toBeNull();
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/auth.session.test.ts`
Expected: FAIL — the "ends a session issued before the password changed" case returns a token instead of `null`, because the callback does not read the database yet.

- [ ] **Step 3: Write minimal implementation**

In `lib/auth.ts`, add the import beside the others:

```ts
import { isSessionStale } from "./session-freshness";
```

Replace the `jwt` callback with:

```ts
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role?: string }).role ?? "USER";
        return token;
      }

      // Every later call. Sessions are stateless JWTs, so a cookie taken before
      // a password change would otherwise keep working until it expired — which
      // is the whole reason this feature stamps passwordChangedAt. Returning
      // null ends the session.
      //
      // This costs a user lookup per session resolution. Accepted: most
      // protected routes already make one through getSessionUser, and a
      // "log out other devices" guarantee that is only sometimes enforced is
      // not a guarantee.
      if (!token.id) return token;
      const row = await prisma.user.findUnique({
        where: { id: token.id as string },
        select: { passwordChangedAt: true },
      });
      if (!row) return null;
      return isSessionStale(token.iat, row.passwordChangedAt) ? null : token;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/auth.session.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the whole suite — this touches every authenticated path**

Run: `npx vitest run`
Expected: PASS. If an existing test mocks `@/lib/auth`, it is unaffected; if one exercises the real config, read the failure before changing it.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts lib/auth.session.test.ts
git commit -m "feat(auth): end sessions issued before the last password change"
```

---

### Task 5: `PUT /api/account/password`

**Files:**
- Create: `app/api/account/password/route.ts`
- Create: `app/api/account/password/route.test.ts`

**Interfaces:**
- Consumes: `passwordField` (Task 1); `User.passwordChangedAt` (Task 3); `getSessionUser` from `@/lib/auth`; `getErrorT` from `@/lib/i18n-server`
- Produces: `PUT` handler at `/api/account/password`

- [ ] **Step 1: Write the failing test**

Create `app/api/account/password/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionUserMock, userFindUnique, userUpdate, compareMock, hashMock } = vi.hoisted(
  () => ({
    getSessionUserMock: vi.fn(),
    userFindUnique: vi.fn(),
    userUpdate: vi.fn(),
    compareMock: vi.fn(),
    hashMock: vi.fn(),
  }),
);

vi.mock("@/lib/auth", () => ({ getSessionUser: getSessionUserMock }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
}));
vi.mock("@/lib/i18n-server", () => ({ getErrorT: async () => (key: string) => key }));
vi.mock("bcryptjs", () => ({ default: { compare: compareMock, hash: hashMock } }));

import { PUT } from "./route";

function call(body: unknown) {
  return PUT(
    new Request("http://test/api/account/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { currentPassword: "oldpassword", newPassword: "newpassword" };

describe("PUT /api/account/password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionUserMock.mockResolvedValue({ id: "u1", email: "a@b.de", role: "USER" });
    userFindUnique.mockResolvedValue({ id: "u1", passwordHash: "$2b$hash" });
    compareMock.mockResolvedValue(true);
    hashMock.mockResolvedValue("$2b$newhash");
    userUpdate.mockResolvedValue({});
  });

  it("refuses without a session, without touching the database", async () => {
    getSessionUserMock.mockResolvedValue(null);
    const res = await call(VALID);
    expect(res.status).toBe(401);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a wrong current password", async () => {
    // The session cookie alone must not be enough to change the password.
    compareMock.mockResolvedValue(false);
    const res = await call(VALID);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "wrongPassword" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a new password under the minimum", async () => {
    const res = await call({ currentPassword: "oldpassword", newPassword: "short" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passwordMin" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a body that is not an object", async () => {
    const res = await call(null);
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a row with no hash without calling bcrypt.compare on null", async () => {
    // bcrypt.compare throws on a null hash; such a row cannot hold a session
    // anyway, so it gets the same answer as a wrong password.
    userFindUnique.mockResolvedValue({ id: "u1", passwordHash: null });
    const res = await call(VALID);
    expect(res.status).toBe(401);
    expect(compareMock).not.toHaveBeenCalled();
  });

  it("writes the new hash and stamps passwordChangedAt together", async () => {
    const res = await call(VALID);
    expect(res.status).toBe(200);

    expect(userUpdate).toHaveBeenCalledTimes(1);
    const args = userUpdate.mock.calls[0][0];
    expect(args.where).toEqual({ id: "u1" });
    expect(args.data.passwordHash).toBe("$2b$newhash");
    expect(args.data.passwordChangedAt).toBeInstanceOf(Date);
  });

  it("never clears a hash, and never touches consent", async () => {
    // The first keeps lib/admin-users.test.ts's invariant true (#52); the
    // second is because changing a password is not a new consent.
    await call(VALID);
    const data = userUpdate.mock.calls[0][0].data;
    expect(data.passwordHash).not.toBeNull();
    expect(data).not.toHaveProperty("termsAcceptedAt");
    expect(data).not.toHaveProperty("termsVersion");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/account/password/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`

- [ ] **Step 3: Write minimal implementation**

Create `app/api/account/password/route.ts`:

```ts
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { passwordField } from "@/lib/password";
import { getErrorT } from "@/lib/i18n-server";

const Schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordField,
});

// Change the password of the logged-in user. Re-authenticates first: the
// session cookie alone must not be enough, exactly as for account deletion
// (app/api/account/route.ts).
export async function PUT(request: Request) {
  const t = await getErrorT();

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: t("notLoggedIn") }, { status: 401 });
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // The only rule that can fail here and mean something to the user is the
    // length of the new password; anything else is a malformed client.
    const onNew = parsed.error.issues.some((i) => i.path.includes("newPassword"));
    return NextResponse.json(
      { error: t(onNew ? "passwordMin" : "invalidRequest") },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, passwordHash: true },
  });

  // The null check stays in the condition because bcrypt.compare against a null
  // hash throws. Such a row cannot hold a session at all (lib/auth.ts rejects it
  // at login), so it needs no answer of its own.
  if (
    !user?.passwordHash ||
    !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))
  ) {
    return NextResponse.json({ error: t("wrongPassword") }, { status: 401 });
  }

  // One write: the hash and the stamp that invalidates every session issued
  // before it must not be able to disagree. termsAcceptedAt and termsVersion
  // are deliberately absent — a password change is not a new consent.
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 10), passwordChangedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/account/password/route.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Confirm the #52 invariant still holds**

Run: `npx vitest run lib/admin-users.test.ts`
Expected: PASS — in particular `writes passwordHash: null in exactly one place`. This route writes a hash; it must not have added a second null writer.

- [ ] **Step 6: Commit**

```bash
git add app/api/account/password/route.ts app/api/account/password/route.test.ts
git commit -m "feat(account): add PUT /api/account/password"
```

---

### Task 6: The copy, in all three locales

**Files:**
- Modify: `messages/de.json`, `messages/en.json`, `messages/it.json` (the `my` and `auth` objects)

**Interfaces:**
- Consumes: nothing
- Produces: `my.passwordTitle`, `my.passwordIntro`, `my.currentPassword`, `my.newPassword`, `my.changePassword`, `my.changingPassword`, `my.changePasswordFailed`, `auth.passwordChangedSignIn`

- [ ] **Step 1: Add the keys to `messages/en.json`**

Inside the `"my"` object, after `"deletedButSignOutFailed"`:

```json
    "passwordTitle": "Password",
    "passwordIntro": "Changing your password signs you out everywhere else.",
    "currentPassword": "Current password",
    "newPassword": "New password (min. 8 characters)",
    "changePassword": "Change password",
    "changingPassword": "Changing…",
    "changePasswordFailed": "The password could not be changed."
```

Inside the `"auth"` object:

```json
    "passwordChangedSignIn": "Your password was changed. Please sign in again."
```

- [ ] **Step 2: Add the same keys to `messages/de.json`**

Inside `"my"`:

```json
    "passwordTitle": "Passwort",
    "passwordIntro": "Wenn du dein Passwort änderst, wirst du überall sonst abgemeldet.",
    "currentPassword": "Aktuelles Passwort",
    "newPassword": "Neues Passwort (min. 8 Zeichen)",
    "changePassword": "Passwort ändern",
    "changingPassword": "Wird geändert…",
    "changePasswordFailed": "Das Passwort konnte nicht geändert werden."
```

Inside `"auth"`:

```json
    "passwordChangedSignIn": "Dein Passwort wurde geändert. Bitte melde dich erneut an."
```

- [ ] **Step 3: Add the same keys to `messages/it.json`**

Inside `"my"`:

```json
    "passwordTitle": "Password",
    "passwordIntro": "Cambiando la password verrai disconnesso da tutti gli altri dispositivi.",
    "currentPassword": "Password attuale",
    "newPassword": "Nuova password (min. 8 caratteri)",
    "changePassword": "Cambia password",
    "changingPassword": "Modifica in corso…",
    "changePasswordFailed": "Non è stato possibile cambiare la password."
```

Inside `"auth"`:

```json
    "passwordChangedSignIn": "La tua password è stata cambiata. Accedi di nuovo."
```

- [ ] **Step 4: Prove the three catalogues have the same shape**

Run:
```bash
node -e "
const de=require('./messages/de.json'), en=require('./messages/en.json'), it=require('./messages/it.json');
const keys = (o, p='') => Object.entries(o).flatMap(([k,v]) => typeof v === 'object' && v !== null ? keys(v, p+k+'.') : [p+k]);
const [d,e,i] = [keys(de), keys(en), keys(it)].map(k => k.sort());
console.log('de', d.length, 'en', e.length, 'it', i.length);
console.log('en missing from de:', e.filter(k => !d.includes(k)));
console.log('en missing from it:', e.filter(k => !i.includes(k)));
console.log('de missing from en:', d.filter(k => !e.includes(k)));
"
```
Expected: the three counts are equal and all three lists are empty.

- [ ] **Step 5: Commit**

```bash
git add messages/de.json messages/en.json messages/it.json
git commit -m "i18n: copy for the password change form"
```

---

### Task 7: The form, and the notice it lands on

**Files:**
- Create: `components/ChangePassword.tsx`
- Create: `components/ChangePassword.test.tsx`
- Modify: `app/[locale]/my/page.tsx:7-8,49-50`
- Modify: `app/[locale]/login/page.tsx:12-13`

**Interfaces:**
- Consumes: `PUT /api/account/password` (Task 5); the keys from Task 6
- Produces: default-exported `ChangePassword` component

- [ ] **Step 1: Write the failing test**

Create `components/ChangePassword.test.tsx`:

```tsx
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import ChangePassword from "./ChangePassword";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: signOutMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  signOutMock.mockResolvedValue(undefined);
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
        <ChangePassword />
      </NextIntlClientProvider>,
    );
  });
}

async function submit(current: string, next: string) {
  const [currentInput, newInput] = Array.from(
    container.querySelectorAll<HTMLInputElement>("input[type=password]"),
  );
  await act(async () => {
    currentInput.value = current;
    currentInput.dispatchEvent(new Event("input", { bubbles: true }));
    newInput.value = next;
    newInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

const text = () => container.textContent ?? "";

describe("ChangePassword", () => {
  it("sends the two passwords to the route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    mount();
    await submit("oldpassword", "newpassword");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/password",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ currentPassword: "oldpassword", newPassword: "newpassword" }),
      }),
    );
  });

  it("signs out to the login notice on success", async () => {
    // The session that made the change predates passwordChangedAt like any
    // other, so this device has to sign in again too.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    mount();
    await submit("oldpassword", "newpassword");

    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/en/login?changed=1" });
  });

  it("shows the message the route sends and stays put", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "That password is not correct." }), { status: 401 })),
    );

    mount();
    await submit("wrongpassword", "newpassword");

    expect(text()).toContain("That password is not correct.");
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("falls back to its own message when the refusal carries no body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 500 })));

    mount();
    await submit("oldpassword", "newpassword");

    expect(text()).toContain(messages.my.changePasswordFailed);
  });

  it("reports a failed request without claiming the password changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    mount();
    await submit("oldpassword", "newpassword");

    expect(text()).toContain(messages.my.changePasswordFailed);
    expect(signOutMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/ChangePassword.test.tsx`
Expected: FAIL — `Failed to resolve import "./ChangePassword"`

- [ ] **Step 3: Write minimal implementation**

Create `components/ChangePassword.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { signOut } from "next-auth/react";
import { PASSWORD_MIN_LENGTH } from "@/lib/password";

export default function ChangePassword() {
  const t = useTranslations("my");
  const locale = useLocale();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    let res: Response;
    try {
      res = await fetch("/api/account/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    } catch (err) {
      // Only the request is caught. A throw from the success handling below
      // must not be reported as a failed change — by then the password is
      // already different, and telling the user otherwise is the worse lie.
      console.error("[my] password change request failed:", err);
      setError(t("changePasswordFailed"));
      setBusy(false);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? t("changePasswordFailed"));
      setBusy(false);
      return;
    }

    // Every session issued before the change is now stale, including this one,
    // so this device signs in again like the others. The notice on /login is
    // what tells the user that was deliberate.
    setCurrentPassword("");
    setNewPassword("");
    await signOut({ callbackUrl: `/${locale}/login?changed=1` });
  }

  return (
    <section style={{ marginTop: 48 }}>
      <h2>{t("passwordTitle")}</h2>
      <p className="muted">{t("passwordIntro")}</p>
      <form onSubmit={submit}>
        <label htmlFor="current-password">{t("currentPassword")}</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />

        <label htmlFor="new-password">{t("newPassword")}</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />

        {error && <p className="error">{error}</p>}

        <button className="button" type="submit" disabled={busy}>
          {busy ? t("changingPassword") : t("changePassword")}
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ChangePassword.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Mount it on `/my`**

In `app/[locale]/my/page.tsx`, add the import beside the others:

```tsx
import ChangePassword from "@/components/ChangePassword";
```

and render it before `DeleteAccount`, so the destructive action stays last:

```tsx
      <ExportAccount />
      <ChangePassword />
      <DeleteAccount />
```

- [ ] **Step 6: Show the notice on `/login`**

In `app/[locale]/login/page.tsx`, after the `callbackUrl` line:

```tsx
  const passwordChanged = params.get("changed") === "1";
```

and render it above the form's error, inside the returned markup:

```tsx
      {passwordChanged && <p className="muted">{t("passwordChangedSignIn")}</p>}
```

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add components/ChangePassword.tsx components/ChangePassword.test.tsx "app/[locale]/my/page.tsx" "app/[locale]/login/page.tsx"
git commit -m "feat(my): add the password change form"
```

---

### Task 8: Changelog, and the gates

**Files:**
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Add the entry**

Under `## [Unreleased]`, in an `### Added` section (create it if absent, above any existing `### Changed`):

```markdown
### Added
- Change your own password from **My puzzles**, under *Password*. The current
  password is required, so a stolen session cookie is not enough on its own.
  Changing it signs you out everywhere else: sessions are stateless tokens, and
  one issued before the change is now refused, which it was not before. The
  device making the change signs in again too, and says so. (#42)
```

- [ ] **Step 2: Run every gate**

Run:
```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```
Expected: all four exit 0. `npm run lint` may still report the five `PuzzleBoard` warnings tracked by #87 — warnings, not errors, so the exit code is 0.

- [ ] **Step 3: Verify it in the browser**

The dev stack runs the app; see the `dev-stack` skill.

```bash
docker compose exec app npm run db:push
docker compose exec app npm run create-user -- pwtest@example.com 'originalpass'
```

Then, at http://localhost:3000/de/my — and in a second browser profile signed in as the same user:

1. Change the password in the first profile; it should land on `/de/login` with the notice.
2. Sign in there with the **new** password.
3. Reload the second profile: it must be signed out, not merely unable to act.
4. Check `/en/my` and `/it/my` so the copy is exercised in more than one locale.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the password change"
```

---

## Notes for the reviewer

- **The jwt callback now reads the database on every session resolution.** That is the accepted cost of enforcing in one place; the alternative left `app/[locale]/my`, `create`, `layout` and the home page — which call `auth()` directly — accepting a stale cookie.
- **The `iat` boundary is deliberately lenient by under a second.** `lib/session-freshness.test.ts` states it. Erring the other way rejects the fresh session of someone signing back in immediately after their own change.
- **Reset by email is not here.** It reuses `passwordChangedAt` and `isSessionStale` unchanged; see the spec's *Out of scope*.
