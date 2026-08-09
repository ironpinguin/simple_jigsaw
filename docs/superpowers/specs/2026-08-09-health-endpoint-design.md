# Health endpoints and an unattended retention sweep — design

Issue: #44 (follow-up to #20, sub-issue of #2). Branch: `feat/44-health-endpoint`.

#20 / #43 delete expired tokens, but the only unattended trigger is
`createToken`. An instance that stops issuing tokens — `REGISTRATION_ENABLED=false`
and nobody inviting — never sweeps again, while `legal.retentionText` promises
deletion without that condition in all three catalogs. This closes the gap so
the policy text is true for any running container, and adds the health
endpoints the deployment lacks anyway.

## Decisions made during brainstorming

- **The trigger is a timer, plus the readiness probe**, both behind one
  throttled function. The probe alone would leave an instance without a
  configured healthcheck sweeping never — the same class of gap this issue
  exists to close. The timer alone would sweep less often than it looks on a
  cluster that rolls pods between ticks.
- **Two endpoints, not one.** A liveness probe that checks the database
  restarts the pod when Postgres blips, which is a crashloop waiting to happen.
  `/api/health` answers for the process, `/api/health/ready` answers for the
  database.
- **The sweep trigger is public, defended by the throttle** rather than by a
  secret. #20 states that "endpoint-triggered sweeps must not be reachable
  unauthenticated"; the reasoning is recorded under *Reconciling #20* below.
- **The throttle is in-memory and fixed at one hour.** No schema change, no new
  environment variable. The shortest TTL is 24 h (`EMAIL_VERIFY`), so hourly is
  ample.
- **The Kubernetes example covers the app only.** Postgres and object storage
  come from the cluster; shipping a Postgres StatefulSet in an example file is
  how people end up running one in production.
- **No policy edit.** The wording that #43 shipped becomes true, so the three
  catalogs and `PRIVACY_UPDATED` stay untouched.

## Current state

Verified, not assumed:

- `middleware.ts` matches `/((?!api|_next|_vercel|.*\..*).*)`, so `/api/health`
  is never locale-prefixed and needs no i18n handling.
- The runner stage is `node:22-alpine`, and `apk add` there installs only
  `libc6-compat` and `openssl` — so a healthcheck may rely on the base image and
  on `node`, nothing else.
- `docker-compose.yml` defines a healthcheck for `postgres` and none for `app`.
- There is no `instrumentation.ts`; `package.json` declares Next `^15.1.4`,
  the installed version is 15.5.21, and `register()` is stable there too.
- `createToken` sweeps unthrottled on every token issued (`lib/tokens.ts`).

## Reconciling #20

#20 asks that an endpoint-triggered sweep not be reachable unauthenticated. A
probe endpoint cannot carry a session: neither Docker's `HEALTHCHECK` nor the
kubelet has one, and a required secret would mean the default deployment sweeps
only after an operator configures it — failing the goal of this issue.

The concern behind the constraint is met instead by construction:

- **Not a data exposure.** The response says whether the process and the
  database answer. It carries no count, no identifier, nothing derived from a
  row.
- **Not an amplification target.** The throttle is checked before any query, so
  a caller hammering the endpoint gets at most one `DELETE` per hour from it —
  the same load as one probe.
- **Not a new surface.** The sweep runs on a timer regardless; the endpoint only
  brings it forward within the same hourly budget.

The throttle bounds the `DELETE`, but the readiness handler's `SELECT 1` runs
on every request, unthrottled — an unauthenticated caller can make the
instance query its database as often as it likes. This is not a new exposure
class: `app/api/report/route.ts` already reaches the database on
unauthenticated requests. The real mitigation for a database slow enough for
that to matter is not authenticating the probe but bounding how long any one
caller can wait on it — `deploy/kubernetes/deployment.yaml`'s readiness probe
sets `timeoutSeconds: 5` and `failureThreshold: 5` for that reason.

A comment on #20 records this so the constraint reads as satisfied rather than
ignored.

## Components

### Throttle — `lib/retention.ts`

```ts
export async function maybePurgeExpiredTokens(now?: number): Promise<number | null>;
```

Module-level `lastSweepAt`, and an exported `SWEEP_INTERVAL_MS = 60 * 60 * 1000`
so `instrumentation.ts` schedules on the same constant the throttle enforces.

Returns the number of rows deleted, or `null` when the call was throttled or
when the sweep failed. Nothing distinguishes those two cases, and nothing needs
to: the return value exists for the tests and for a future log line, and no
caller branches on it.

`purgeExpiredTokens` **moves here** from `lib/tokens.ts`. Leaving it there
would make the two modules import each other — retention needs the sweep,
tokens needs the throttle — so retention owns the sweep and tokens consumes it.
`scripts/purge-expired.mjs` is unaffected: it never imported the function, it
repeats the `deleteMany` because it runs under plain `node`.

`maybePurgeExpiredTokens` owns the catch-and-log and never throws — every
caller is either a probe that must not fail for housekeeping or a registration
that must not fail for it either.

`lastSweepAt` is stamped **before** awaiting the delete. Two probes arriving
together would otherwise both find the sweep due and both run it.

### Startup and timer — `instrumentation.ts`

`register()` sweeps once at startup and then every `SWEEP_INTERVAL_MS`, guarded on
`process.env.NEXT_RUNTIME === "nodejs"` so the edge runtime does not try, and
with `.unref()` on the interval so it never holds the process open.

### Liveness — `app/api/health/route.ts`

`GET` → `200 {"ok":true}`. No database access, so it answers as long as the
process serves requests. `dynamic = "force-dynamic"` and `Cache-Control:
no-store`, or a probe would read a cached answer.

### Readiness — `app/api/health/ready/route.ts`

`GET` → `SELECT 1` via a tagged `$queryRaw` (not `$queryRawUnsafe`, which
Semgrep flags), then `maybePurgeExpiredTokens()`.

- database answered → `200 {"ok":true,"db":"up"}`
- it did not → `503 {"ok":false,"db":"down"}`, with no error detail in the body

The sweep runs only when the database answered, and its outcome never changes
the status code: retention housekeeping must not take a pod out of the load
balancer.

### `createToken` — `lib/tokens.ts`

Switches from `purgeExpiredTokens` to `maybePurgeExpiredTokens`. With the timer
in place the per-issuance sweep is redundant, and routing it through the
throttle gives one code path, one place that logs, at most one sweep per hour
across all triggers, and no full-table `DELETE` on every registration.

`purgeExpiredTokens` stays exported and unthrottled from its new home, for the
tests and for any caller that wants the sweep itself rather than the budget.

## Deployment

### `docker-compose.yml` and `docker-compose.sqlite.yml`

The same healthcheck goes on the `app` service in both compose files — the
sqlite stack is its own Compose project, not an override of the Postgres one,
so it needs the block too.

```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/api/health/ready"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 40s
```

`start_period` covers `npm run db:push`, which the container's `CMD` runs before
`next start`.

This assumes busybox `wget` in the alpine base. **Not verified** — the Docker
daemon was not running when this was written — so confirm it first:

```bash
docker run --rm node:22-alpine which wget
```

If it is absent, the fallback needs nothing but the image's own runtime:

```yaml
test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
```

### `deploy/kubernetes/`

`deployment.yaml` (liveness → `/api/health`, readiness → `/api/health/ready`),
`service.yaml`, `configmap.yaml` for the non-secret environment,
`secret.example.yaml` for `AUTH_SECRET`, `DATABASE_URL` and the S3 keys, and a
`README.md` stating that Postgres and object storage come from the cluster and
that N replicas mean up to N sweeps per hour — harmless on a table this sweep
keeps small, but it should not be a surprise.

## Documentation

- README, German admin section: the sweep runs automatically while the container
  runs; `npm run purge-expired` stays for the one-off catch-up.
- CHANGELOG: `Added` for the endpoints, `Changed` for the sweep trigger.
- `.env.example`: unchanged, since the design introduces no new variable.

## Tests

- `lib/retention.test.ts` — sweeps on the first call; no-ops inside the hour;
  sweeps again after it; concurrent callers sweep once; a failure is logged and
  swallowed, and is not retried until the interval is up. The existing
  `purgeExpiredTokens` tests move here with the function.
- `app/api/health/route.test.ts` — status and shape, and that it reaches no
  database.
- `app/api/health/ready/route.test.ts` — 200 and a sweep when the database
  answers; 503 and **no** sweep when `$queryRaw` rejects; a failing sweep still
  yields 200.
- `lib/tokens.test.ts` — updated for the throttled call.

`instrumentation.ts` gets no test of its own: it is wiring around a function
tested directly, and `vitest.config.ts` defines projects for `lib/**`,
`components/**` and `app/api/**` only.

## Out of scope

No Helm chart (worth its own issue if wanted), no Postgres or storage manifests,
no schema change, no new environment variable, and no change to the privacy
policy.
