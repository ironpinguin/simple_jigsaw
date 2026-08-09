# Health Endpoints and Unattended Retention Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expired verification tokens are deleted on any running container without an operator scheduling anything, and the deployment gains the liveness/readiness endpoints it currently lacks.

**Architecture:** One throttled function, `maybePurgeExpiredTokens`, is the only way the sweep is ever triggered. Three callers share its hourly budget: a startup timer in `instrumentation.ts`, the readiness endpoint, and `createToken`. Liveness and readiness are separate endpoints so that a database outage cannot restart the pod.

**Tech Stack:** Next.js 15 App Router (route handlers, `instrumentation.ts`), TypeScript, Prisma, Vitest, Docker Compose, plain Kubernetes manifests.

Design spec: [`docs/superpowers/specs/2026-08-09-health-endpoint-design.md`](../specs/2026-08-09-health-endpoint-design.md). Issue: #44.

## Global Constraints

- The three quality gates must pass before the PR: `npm run lint`, `npm test`, `npm run build`.
- Every user-facing change gets a bullet under `## [Unreleased]` in `CHANGELOG.md`.
- **No new user-facing strings in this feature.** The endpoints return JSON consumed by machines, so `messages/{de,en,it}.json` are not touched. If that changes, all three catalogs must be edited together.
- **No privacy-policy edit and no `PRIVACY_UPDATED` bump.** The wording shipped in #43 becomes true; that is the point of this work.
- **No schema change**, no new environment variable.
- `lib/` stays free of React and I/O concerns that belong in routes.
- Sweep interval is exactly `60 * 60 * 1000` ms, exported as `SWEEP_INTERVAL_MS` from `lib/retention.ts` so nothing restates the number.
- Import style: files under `lib/` import siblings relatively (`./tokens`); files under `app/` use the `@/` alias.
- Commit messages use Conventional Commit prefixes.

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/retention.ts` | **New.** Owns `purgeExpiredTokens` (moved here) and `maybePurgeExpiredTokens` (throttle + logging). |
| `lib/retention.test.ts` | **New.** Throttle behaviour, plus the `purgeExpiredTokens` tests moved out of `lib/tokens.test.ts`. |
| `lib/tokens.ts` | **Modify.** Drops `purgeExpiredTokens`; `createToken` calls the throttled version. |
| `lib/tokens.test.ts` | **Modify.** Mocks `./retention`; loses the purge tests that moved. |
| `app/api/health/route.ts` | **New.** Liveness. No database access. |
| `app/api/health/route.test.ts` | **New.** |
| `app/api/health/ready/route.ts` | **New.** Readiness + throttled sweep. |
| `app/api/health/ready/route.test.ts` | **New.** |
| `instrumentation.ts` | **New.** Startup sweep and hourly interval. |
| `docker-compose.yml` | **Modify.** Healthcheck on the `app` service. |
| `deploy/kubernetes/*.yaml`, `deploy/kubernetes/README.md` | **New.** App-only example with both probes. |
| `README.md`, `CHANGELOG.md` | **Modify.** |

**Why `purgeExpiredTokens` moves:** `lib/retention.ts` needs it and `lib/tokens.ts` needs the throttle. Leaving the function in `tokens.ts` makes the two modules import each other. Retention owns the sweep; tokens consumes it.

---

### Task 1: The throttle in `lib/retention.ts`

**Files:**
- Create: `lib/retention.ts`
- Create: `lib/retention.test.ts`
- Modify: `lib/tokens.ts` (remove `purgeExpiredTokens`, call the throttled version)
- Modify: `lib/tokens.test.ts` (mock `./retention`, drop the moved tests)

**Interfaces:**
- Consumes: `expiredTokenFilter(now: number): { expiresAt: { lt: Date } }` from `lib/token-ttl.ts`; `prisma` from `lib/db.ts`.
- Produces: `SWEEP_INTERVAL_MS: number`, `purgeExpiredTokens(now?: number): Promise<number>`, `maybePurgeExpiredTokens(now?: number): Promise<number | null>`. Tasks 3, 4 and this task's `lib/tokens.ts` edit all depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `lib/retention.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expiredTokenFilter } from "./token-ttl";

const { deleteMany } = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("./db", () => ({
  prisma: { verificationToken: { deleteMany } },
}));

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

/**
 * The throttle keeps its state in module scope, which is what makes it a
 * throttle. Each test therefore needs a fresh copy of the module rather than a
 * reset hook that exists only for the tests.
 */
async function freshRetention() {
  vi.resetModules();
  return import("./retention");
}

beforeEach(() => {
  deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("purgeExpiredTokens", () => {
  it("deletes the expired rows and reports how many", async () => {
    const { purgeExpiredTokens } = await freshRetention();
    deleteMany.mockResolvedValue({ count: 7 });

    await expect(purgeExpiredTokens(NOW)).resolves.toBe(7);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });
});

describe("maybePurgeExpiredTokens", () => {
  it("sweeps on the first call", async () => {
    const { maybePurgeExpiredTokens } = await freshRetention();
    deleteMany.mockResolvedValue({ count: 3 });

    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: expiredTokenFilter(NOW) });
  });

  it("does nothing when called again inside the interval", async () => {
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await freshRetention();
    await maybePurgeExpiredTokens(NOW);

    await expect(maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS - 1)).resolves.toBeNull();
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("sweeps again once the interval has passed", async () => {
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await freshRetention();
    await maybePurgeExpiredTokens(NOW);

    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS);

    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it("sweeps once when two callers arrive together", async () => {
    // The timestamp is stamped before the await. Without that, two probes
    // landing in the same tick would both find the sweep due and both issue a
    // table-wide DELETE.
    const { maybePurgeExpiredTokens } = await freshRetention();

    await Promise.all([maybePurgeExpiredTokens(NOW), maybePurgeExpiredTokens(NOW)]);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("logs a failed sweep instead of throwing", async () => {
    // Callers are a readiness probe, a startup timer with nobody to catch it,
    // and token issuance — none of them may fail because housekeeping did. It
    // must not be silent either: the privacy policy promises this runs.
    const { maybePurgeExpiredTokens } = await freshRetention();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("db is having a day"));

    await expect(maybePurgeExpiredTokens(NOW)).resolves.toBeNull();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("purge of expired tokens failed"),
      expect.any(Error),
    );
  });

  it("does not retry a failed sweep until the interval is up", async () => {
    // A database that rejects the DELETE will still reject it a second later.
    // Retrying on every probe would hammer it while it is already unwell.
    const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await freshRetention();
    vi.spyOn(console, "error").mockImplementation(() => {});
    deleteMany.mockRejectedValue(new Error("db is having a day"));

    await maybePurgeExpiredTokens(NOW);
    await maybePurgeExpiredTokens(NOW + SWEEP_INTERVAL_MS - 1);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project lib lib/retention.test.ts`
Expected: FAIL — `Failed to load ./retention` / module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/retention.ts`:

```ts
// Retention sweep for expired tokens (GDPR Art. 5(1)(e), storage limitation)
// and the throttle every trigger shares.
//
// The privacy policy promises expired links are removed automatically, so the
// sweep must not depend on an operator scheduling anything. It is driven from
// three places — the startup timer in instrumentation.ts, the readiness probe,
// and createToken — which is why the budget lives here rather than at any one
// of them.

import { prisma } from "./db";
import { expiredTokenFilter } from "./token-ttl";

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt: number | null = null;

/**
 * Delete every token past its expiry and report how many went. An expired row
 * has no purpose left — `consumeToken` refuses it — so keeping it is storing
 * personal data for nothing.
 *
 * Unthrottled: this is the sweep itself. Callers that run on a trigger they do
 * not control want `maybePurgeExpiredTokens`.
 *
 * `scripts/purge-expired.mjs` performs the same deletion independently — it
 * runs under plain `node` with no TS loader, so it cannot import this module;
 * keep the two in step.
 */
export async function purgeExpiredTokens(now: number = Date.now()): Promise<number> {
  const { count } = await prisma.verificationToken.deleteMany({
    where: expiredTokenFilter(now),
  });
  return count;
}

/**
 * Sweep at most once per `SWEEP_INTERVAL_MS` across every caller. Returns the
 * number of rows deleted, or null when the call was throttled or the sweep
 * failed — nothing branches on the difference.
 *
 * Never throws. Its callers are a readiness probe that must not fail for
 * housekeeping, a timer with nobody to catch it, and token issuance that must
 * not turn into a 500 the user cannot act on.
 */
export async function maybePurgeExpiredTokens(
  now: number = Date.now(),
): Promise<number | null> {
  if (lastSweepAt !== null && now - lastSweepAt < SWEEP_INTERVAL_MS) return null;

  // Stamped before the await, not after: two probes arriving in the same tick
  // would otherwise both find the sweep due and both run it. It also means a
  // failed sweep waits out the interval rather than retrying on every probe.
  lastSweepAt = now;

  try {
    return await purgeExpiredTokens(now);
  } catch (error) {
    console.error("[retention] purge of expired tokens failed; they stay stored:", error);
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project lib lib/retention.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Point `lib/tokens.ts` at the throttle**

Remove the `purgeExpiredTokens` export and its import of `expiredTokenFilter`, then replace the sweep in `createToken`. The file's imports become:

```ts
import { randomBytes } from "crypto";
import { prisma } from "./db";
import { tokenExpiry, isExpired, type TokenKind } from "./token-ttl";
import { maybePurgeExpiredTokens } from "./retention";
```

And the body of `createToken`:

```ts
export async function createToken(userId: string, type: TokenKind): Promise<string> {
  const now = Date.now();

  // Housekeeping on the way past, sharing the hourly budget with the timer in
  // instrumentation.ts and the readiness probe. Issuing a token therefore no
  // longer means a table-wide DELETE, and the one place that logs a failed
  // sweep is lib/retention.ts.
  await maybePurgeExpiredTokens(now);

  const token = randomBytes(32).toString("hex");
  await prisma.verificationToken.create({
    data: { token, type, userId, expiresAt: tokenExpiry(type, now) },
  });
  return token;
}
```

`consumeToken` is untouched.

- [ ] **Step 6: Update `lib/tokens.test.ts`**

Delete the whole `describe("purgeExpiredTokens", …)` block and the `"still issues the token when the purge fails, and says so"` test — both now live in `lib/retention.test.ts`. Replace the `deleteMany` mock with a `./retention` mock. The top of the file becomes:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { create, findUnique, deleteOne, maybePurge } = vi.hoisted(() => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  deleteOne: vi.fn(),
  maybePurge: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    verificationToken: { create, delete: deleteOne, findUnique },
  },
}));
vi.mock("./retention", () => ({ maybePurgeExpiredTokens: maybePurge }));

import { consumeToken, createToken } from "./tokens";
import { tokenExpiry } from "./token-ttl";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  create.mockResolvedValue({});
  deleteOne.mockResolvedValue({});
  maybePurge.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
```

and the sweep test becomes:

```ts
  it("asks for a sweep when it issues a token", async () => {
    // Without the timer or a probe — a bare `docker run` — issuing a token is
    // the only thing that cleans the table. The throttle decides whether the
    // sweep actually runs; this only pins that the ask happens.
    await createToken("user-1", "EMAIL_VERIFY");

    expect(maybePurge).toHaveBeenCalledWith(NOW);
  });
```

Keep the existing `"stores a random token with the type's expiry"`, `"returns a different token every time"` and the four `consumeToken` tests unchanged.

- [ ] **Step 7: Run the whole lib project**

Run: `npx vitest run --project lib`
Expected: PASS. Token and retention suites green; no other file imports `purgeExpiredTokens` from `./tokens` (verify with `grep -rn "purgeExpiredTokens" lib/ app/ scripts/`).

- [ ] **Step 8: Commit**

```bash
git add lib/retention.ts lib/retention.test.ts lib/tokens.ts lib/tokens.test.ts
git commit -m "feat(retention): throttle the sweep and give it a home of its own"
```

---

### Task 2: Liveness endpoint

**Files:**
- Create: `app/api/health/route.ts`
- Create: `app/api/health/route.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GET(): Promise<NextResponse>` at `/api/health`, answering `200 {"ok":true}`. Task 5 and Task 6 point probes at this path.

- [ ] **Step 1: Write the failing test**

Create `app/api/health/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project api app/api/health/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";

// Liveness only. It deliberately touches nothing: a probe that checks the
// database restarts the pod when the database blips, which turns someone
// else's outage into a crashloop. Readiness lives at /api/health/ready.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project api app/api/health/route.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/health/route.ts app/api/health/route.test.ts
git commit -m "feat(health): liveness endpoint that answers without the database"
```

---

### Task 3: Readiness endpoint with the sweep

**Files:**
- Create: `app/api/health/ready/route.ts`
- Create: `app/api/health/ready/route.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/lib/db`; `maybePurgeExpiredTokens(now?: number): Promise<number | null>` from `@/lib/retention` (Task 1).
- Produces: `GET(): Promise<NextResponse>` at `/api/health/ready`, answering `200 {"ok":true,"db":"up"}` or `503 {"ok":false,"db":"down"}`. Tasks 5 and 6 point probes at this path.

- [ ] **Step 1: Write the failing test**

Create `app/api/health/ready/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw, maybePurge } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  maybePurge: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: queryRaw } }));
vi.mock("@/lib/retention", () => ({ maybePurgeExpiredTokens: maybePurge }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ one: 1 }]);
  maybePurge.mockResolvedValue(null);
});

describe("GET /api/health/ready", () => {
  it("reports the database as up and asks for a sweep", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, db: "up" });
    expect(maybePurge).toHaveBeenCalled();
  });

  it("answers 503 when the database does not", async () => {
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await GET();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ ok: false, db: "down" });
  });

  it("does not sweep when the database is down", async () => {
    // The sweep would only fail too, and it would take the throttle's hourly
    // budget with it.
    queryRaw.mockRejectedValue(new Error("ECONNREFUSED"));

    await GET();

    expect(maybePurge).not.toHaveBeenCalled();
  });

  it("stays ready when the sweep throws", async () => {
    // maybePurgeExpiredTokens handles its own failures, so this can only be a
    // bug in the throttle itself — and retention housekeeping must never take
    // a pod out of the load balancer.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    maybePurge.mockRejectedValue(new Error("sweep exploded"));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("puts no error detail in the response", async () => {
    // The endpoint is public, and Prisma's connection errors quote the DSN.
    queryRaw.mockRejectedValue(new Error("password authentication failed for user jigsaw"));

    const res = await GET();

    await expect(res.text()).resolves.not.toContain("password");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project api app/api/health/ready/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the implementation**

Create `app/api/health/ready/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { maybePurgeExpiredTokens } from "@/lib/retention";

// Readiness: can this instance actually serve requests? Kubernetes takes a
// failing pod out of the Service on this, and compose reports the container
// unhealthy. Liveness — which must not depend on the database — is /api/health.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    // Deliberately not logged: a probe runs every few seconds, so this would
    // fill the log at exactly the moment an operator needs to read it. The 503
    // is itself the signal. The body carries no detail either — the endpoint is
    // public and Prisma's connection errors quote the DSN.
    return NextResponse.json({ ok: false, db: "down" }, { status: 503, headers: NO_STORE });
  }

  // Housekeeping rides along on a trigger that exists anyway, throttled to at
  // most one sweep an hour across every caller. It cannot fail the probe: the
  // catch is for a bug in the throttle itself, which handles its own errors.
  await maybePurgeExpiredTokens().catch((error) => {
    console.error("[health] retention sweep threw unexpectedly:", error);
  });

  return NextResponse.json({ ok: true, db: "up" }, { headers: NO_STORE });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project api app/api/health/ready/route.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/api/health/ready/route.ts app/api/health/ready/route.test.ts
git commit -m "feat(health): readiness endpoint that sweeps expired tokens as it goes"
```

---

### Task 4: Startup sweep and hourly timer

**Files:**
- Create: `instrumentation.ts` (repository root, next to `middleware.ts`)

**Interfaces:**
- Consumes: `maybePurgeExpiredTokens`, `SWEEP_INTERVAL_MS` from `@/lib/retention` (Task 1).
- Produces: `register(): Promise<void>`, the hook Next calls once per server start. Nothing imports it.

- [ ] **Step 1: Write the implementation**

There is no unit test for this file: it is wiring around a function tested directly in Task 1, and `vitest.config.ts` only collects `lib/**`, `components/**` and `app/api/**`. Verification is the manual check in Step 2.

Create `instrumentation.ts`:

```ts
// Next calls register() once when the server starts.
//
// The retention sweep must not depend on anyone configuring a probe: an
// operator running the image with a compose file of their own still gets the
// deletion the privacy policy promises. The readiness endpoint calls the same
// throttled function, so the two together stay within one sweep per hour.

export async function register() {
  // The edge runtime has no Prisma client and no long-lived process to hold a
  // timer; only the Node.js server runtime should schedule anything.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await import("@/lib/retention");

  // Not awaited: startup must not wait on the database, and the function
  // handles its own failures.
  void maybePurgeExpiredTokens();

  // unref, so housekeeping is never the reason the process stays alive.
  setInterval(() => void maybePurgeExpiredTokens(), SWEEP_INTERVAL_MS).unref();
}
```

- [ ] **Step 2: Verify the hook actually runs**

Run: `npm run build && npx next start` (or `npm run dev`), then in another shell:

```bash
curl -s localhost:3000/api/health && echo && curl -s localhost:3000/api/health/ready
```

Expected: `{"ok":true}` and `{"ok":true,"db":"up"}`. The server log shows no `[retention]` error. If the database is not running, expect the `[retention]` line from Task 1 and a `503` from readiness — that is the correct behaviour, not a failure of this step.

- [ ] **Step 3: Run the gates**

Run: `npm run lint && npm test && npm run build`
Expected: all three pass. `next build` must report `instrumentation.ts` compiled without a type error.

- [ ] **Step 4: Commit**

```bash
git add instrumentation.ts
git commit -m "feat(retention): sweep at startup and hourly, independent of any probe"
```

---

### Task 5: Compose healthcheck and README

**Files:**
- Modify: `docker-compose.yml` (the `app` service)
- Modify: `README.md` (German admin section, the `Abgelaufene Links aufräumen` bullet)

**Interfaces:**
- Consumes: `/api/health/ready` from Task 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Confirm the healthcheck binary exists**

Run: `docker run --rm node:22-alpine which wget`
Expected: `/usr/bin/wget`.

If that prints nothing, use the Node form in Step 2 instead — it needs nothing beyond the image's own runtime:

```yaml
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
```

- [ ] **Step 2: Add the healthcheck**

In `docker-compose.yml`, in the `app` service, after the `environment:` block and before `depends_on:`:

```yaml
    # start_period covers `npm run db:push`, which the container's CMD runs
    # before `next start`. /ready rather than /health, because an app that
    # cannot reach the database is not doing its job — and the probe is what
    # keeps the retention sweep running on an idle instance.
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/api/health/ready"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
```

- [ ] **Step 3: Verify it against a running stack**

Run:

```bash
docker compose -f docker-compose.yml up -d --build
docker compose ps                     # STATUS should reach "healthy"
docker compose logs app | tail -20
```

Expected: `app` reports `healthy` within roughly a minute. If it stays `starting` longer than `start_period + interval * retries`, raise `start_period` rather than lowering `retries` — `db:push` is the slow part, and this is the value the spec flagged as a guess.

Then: `docker compose down`.

- [ ] **Step 4: Update the README**

In `README.md`, replace the existing `**Abgelaufene Links aufräumen**` bullet with:

```markdown
- **Abgelaufene Links aufräumen**: Bestätigungs- und Einladungs-Tokens werden
  beim Einlösen gelöscht, abgelaufene automatisch — beim Start des Containers
  und danach stündlich, zusätzlich bei jedem Readiness-Check (Art. 5 Abs. 1
  lit. e DSGVO, Speicherbegrenzung). Eine laufende Instanz hält sich damit
  selbst sauber, ohne dass etwas eingerichtet werden muss. Für einen einmaligen
  Nachlauf auf einer länger laufenden Instanz:
  - `docker compose exec app npm run purge-expired`
```

The cron line goes: it is no longer needed, and a daily cron mail saying `removed 0 expired tokens` is what makes operators redirect the job's output to `/dev/null`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "feat(compose): healthcheck on the app service, driving the sweep"
```

---

### Task 6: Kubernetes example

**Files:**
- Create: `deploy/kubernetes/deployment.yaml`
- Create: `deploy/kubernetes/service.yaml`
- Create: `deploy/kubernetes/configmap.yaml`
- Create: `deploy/kubernetes/secret.example.yaml`
- Create: `deploy/kubernetes/README.md`

**Interfaces:**
- Consumes: `/api/health` and `/api/health/ready` from Tasks 2 and 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the Deployment**

Create `deploy/kubernetes/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jigsaw
  labels: { app: jigsaw }
spec:
  replicas: 1
  selector:
    matchLabels: { app: jigsaw }
  template:
    metadata:
      labels: { app: jigsaw }
    spec:
      containers:
        - name: app
          image: ghcr.io/ironpinguin/simple_jigsaw:latest
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef: { name: jigsaw-config }
            - secretRef: { name: jigsaw-secrets }
          # Liveness must not depend on the database: restarting the app
          # because Postgres blipped turns someone else's outage into a
          # crashloop. Readiness is where the database belongs — a pod that
          # cannot reach it should leave the Service, not die.
          livenessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /api/health/ready, port: 3000 }
            periodSeconds: 10
            failureThreshold: 3
          # The container runs `prisma db push` before `next start`.
          startupProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 5
            failureThreshold: 24
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 1Gi }
```

- [ ] **Step 2: Write the Service, ConfigMap and Secret stub**

Create `deploy/kubernetes/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: jigsaw
spec:
  selector: { app: jigsaw }
  ports:
    - port: 80
      targetPort: 3000
```

Create `deploy/kubernetes/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: jigsaw-config
data:
  DATABASE_PROVIDER: postgresql
  STORAGE_DRIVER: s3
  S3_REGION: us-east-1
  S3_BUCKET: jigsaw
  S3_FORCE_PATH_STYLE: "true"
  APP_URL: https://jigsaw.example.org
  REGISTRATION_ENABLED: "true"
  SMTP_HOST: smtp.example.org
  SMTP_PORT: "587"
  SMTP_SECURE: "true"
  SMTP_FROM: Jigsaw <no-reply@example.org>
  # See .env.example for what each LEGAL_* value says on the page and which
  # three are required.
  LEGAL_NAME: ""
  LEGAL_ADDRESS: ""
  LEGAL_EMAIL: ""
```

Create `deploy/kubernetes/secret.example.yaml`:

```yaml
# Copy to secret.yaml, fill in, and keep it out of git.
#   AUTH_SECRET: openssl rand -base64 32
apiVersion: v1
kind: Secret
metadata:
  name: jigsaw-secrets
type: Opaque
stringData:
  AUTH_SECRET: change-me
  DATABASE_URL: postgresql://jigsaw:jigsaw@postgres:5432/jigsaw?schema=public
  S3_ENDPOINT: http://rustfs:9000
  S3_ACCESS_KEY_ID: change-me
  S3_SECRET_ACCESS_KEY: change-me
  SMTP_USER: change-me
  SMTP_PASS: change-me
```

- [ ] **Step 3: Write the README**

Create `deploy/kubernetes/README.md`:

```markdown
# Kubernetes example

An example, not a product: the app only. Postgres and the S3-compatible object
storage are expected to exist already — a managed database and bucket, or your
own charts. Point `DATABASE_URL` and the `S3_*` values at them.

```bash
cp secret.example.yaml secret.yaml   # fill in, keep out of git
kubectl apply -f configmap.yaml -f secret.yaml -f deployment.yaml -f service.yaml
```

## The probes

- **liveness → `/api/health`** answers as long as the process serves requests
  and touches no database. Pointing liveness at the readiness path instead
  would restart every pod whenever the database blips.
- **readiness → `/api/health/ready`** checks the database and answers `503`
  when it is unreachable, taking the pod out of the Service until it recovers.
- **startup → `/api/health`** covers `prisma db push`, which the container runs
  before starting the server.

## Retention and replicas

Expired confirmation and invitation links are deleted at startup, hourly, and
on readiness checks (GDPR Art. 5(1)(e)). The interval is tracked per process,
so `replicas: N` means up to N sweeps an hour instead of one. That is a
`DELETE` against a table this sweep keeps small — harmless, but worth knowing
before you read the query log.

If you would rather have exactly one sweep, run the script on a schedule and
ignore that the pods also do it:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jigsaw-purge-expired
spec:
  schedule: "0 4 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: purge
              image: ghcr.io/ironpinguin/simple_jigsaw:latest
              command: ["npm", "run", "purge-expired"]
              envFrom:
                - secretRef: { name: jigsaw-secrets }
```
```

- [ ] **Step 4: Validate the manifests**

Run: `kubectl apply --dry-run=client -f deploy/kubernetes/deployment.yaml -f deploy/kubernetes/service.yaml -f deploy/kubernetes/configmap.yaml -f deploy/kubernetes/secret.example.yaml`
Expected: four `… (dry run)` lines, no error.

If `kubectl` is not installed, validate the YAML syntax instead and say so in the PR:

```bash
node -e "const fs=require('fs');for(const f of fs.readdirSync('deploy/kubernetes').filter(f=>f.endsWith('.yaml')))console.log(f, fs.readFileSync('deploy/kubernetes/'+f,'utf8').length)"
```

- [ ] **Step 5: Commit**

```bash
git add deploy/kubernetes
git commit -m "docs(deploy): Kubernetes example with both probes"
```

**Landed beyond this task's original scope:** `configmap.yaml` also ships an
empty `ADMIN_EMAILS`, and `README.md` gained a *Legal pages* section — both
follow-ups once the manifest was checked against `.env.example`, covered in
later commits (`feat(deploy): document ADMIN_EMAILS in the Kubernetes
configmap`, `docs(deploy): warn that empty legal vars ship an incomplete
imprint`). Recorded here so the plan matches what shipped.

---

### Task 7: Changelog, issue note, final gates

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the changelog entries**

Under `## [Unreleased]` → `### Added`, as the first bullet:

```markdown
- Liveness and readiness endpoints (`/api/health`, `/api/health/ready`), a
  healthcheck for the `app` service in `docker-compose.yml`, and a Kubernetes
  example under `deploy/kubernetes/` that wires both probes. (#44)
```

Under `### Changed`, as the first bullet:

```markdown
- Expired confirmation and invitation links are now deleted whenever the
  container runs — at startup, hourly, and on every readiness check — instead
  of only when a token happens to be issued. An instance with registration
  disabled therefore keeps its promise from the privacy policy too, and issuing
  a token no longer means a table-wide delete. (#44)
```

- [ ] **Step 2: Run the gates on the final state**

Run: `npm run lint && npm test && npm run build`
Expected: all three pass. Report the actual test count, not "tests pass".

- [ ] **Step 3: Confirm the policy really is untouched**

Run: `git diff main...HEAD --name-only | grep -E "messages/|lib/legal.ts" || echo "policy untouched, as designed"`
Expected: `policy untouched, as designed`. If any of those files appear, something drifted from the spec — the whole point is that the code caught up with the text.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): health endpoints and the unattended sweep"
```

- [ ] **Step 5: Record the decision on #20**

```bash
gh issue comment 20 --repo ironpinguin/simple_jigsaw --body "#44 adds a sweep triggered by the readiness probe, which is unauthenticated by necessity — neither Docker's HEALTHCHECK nor the kubelet can carry a session. The constraint recorded here is met by construction rather than by a secret: the response carries nothing derived from a row, and the throttle is checked before any query, so a caller polling the endpoint gets at most one delete per hour — the same load as one probe. See docs/superpowers/specs/2026-08-09-health-endpoint-design.md."
```

- [ ] **Step 6: Ship**

Use the `ship` skill: gates → changelog → PR with `Closes #44` → move the board card to *In review*.

---

## Self-Review

**Spec coverage** — every section of the design maps to a task: throttle → 1, liveness → 2, readiness → 3, timer → 4, compose + README → 5, Kubernetes → 6, changelog + #20 note → 7. The spec's "no policy edit" is enforced by an explicit check in Task 7 Step 3, and its unverified `wget` assumption is Task 5 Step 1.

**Deviation from the spec, deliberate:** the spec has `lib/retention.ts` wrapping `purgeExpiredTokens` from `lib/tokens.ts`. That is a circular import, since `tokens.ts` must import the throttle back. The function moves into `lib/retention.ts` instead and `lib/tokens.ts` only consumes it. The spec's *File Structure* table and Task 1 reflect the move; nothing else in the design changes.

**Names used consistently:** `maybePurgeExpiredTokens`, `purgeExpiredTokens`, `SWEEP_INTERVAL_MS`, `lastSweepAt`, `/api/health`, `/api/health/ready`, `jigsaw-config`, `jigsaw-secrets` — each spelled the same way in every task that references it.
