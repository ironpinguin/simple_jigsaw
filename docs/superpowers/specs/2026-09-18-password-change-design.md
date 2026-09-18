# Self-service password change, and ending other sessions — design

The first half of #42. Changing a password is impossible today: nothing writes
`passwordHash` after signup except invite activation
(`app/api/invite/route.ts`), so a user who suspects their password leaked can
only delete the account and start over.

Reset-by-email — the other half of #42 — is deliberately **not** here; see
*Out of scope*.

## Decisions made during brainstorming

- **Split #42 in two.** Change-password first: it needs no mail, no rate
  limiting, no new pages, and it builds the schema column and session
  invalidation that reset-by-email will reuse. Landing the riskier half first
  would mean the mail, enumeration-safety and rate-limiting work arriving
  before the simpler path had proved the shared piece.
- **Enforce staleness in the `jwt` callback**, not in `getSessionUser`. The
  latter is effectively free — it already queries the user, so it would be one
  more column in an existing `select` — but `app/[locale]/my`,
  `app/[locale]/create`, `app/[locale]/layout.tsx` and the home page call
  `auth()` directly and never reach it. A stolen cookie would keep rendering
  exactly the pages this feature exists to protect.
- **The acting device signs in again.** After a successful change the form
  signs out and lands on `/login` with a notice. The alternative — refreshing
  the JWT from a route handler — is the fiddliest corner of Auth.js v5, and
  this is not the code to be subtly wrong in. Re-entering the new password once
  also makes the effect visible, which for a security action is a feature.

## Current state

| Thing | Where | Note |
| --- | --- | --- |
| Password check | `lib/auth.ts:34` | the only `bcrypt.compare` at login |
| Re-authentication | `app/api/account/route.ts:38` | the pattern to copy |
| Password rule | `lib/signup.ts:17,25` | `z.string().min(8)`, written twice |
| Sessions | `lib/auth.ts:15` | stateless JWT, Auth.js default 30-day `maxAge` |
| `jwt` callback | `lib/auth.ts:55` | writes `id`/`role` at sign-in; never reads the DB |

`DefaultJWT` carries `iat` (seconds), and the callback's type is
`Awaitable<JWT | null>` — returning `null` ends the session. Both verified
against `@auth/core` in `node_modules` rather than assumed.

## Schema

```prisma
// Stamped on every password write. Sessions issued before it are rejected
// (lib/session-freshness.ts). Null for accounts whose password has never
// changed, which is every row that exists today.
passwordChangedAt DateTime?
```

Nullable on purpose: `db push` is the mechanism and there are no migrations, so
a required column without a default would offer to reset existing dev data. Null
also means the migration itself logs nobody out.

No enum, no native type attributes, nothing Postgres-specific — it has to push
cleanly on SQLite too, and the `:latest-sqlite` image is a released artifact.

## Components

### `lib/session-freshness.ts` — the comparison, as a pure function

```ts
export function isSessionStale(iatSeconds: number | undefined, changedAt: Date | null): boolean
```

Pure so the boundary is testable without a database or a session.

**The boundary is the interesting part.** `iat` is whole seconds; a
`DateTime` is milliseconds. The comparison is second-to-second — stale when
`iat < Math.floor(changedAt / 1000)` — which leaves a sub-second window where a
token issued just before the change survives. That direction is deliberate:
erring the other way can reject the *fresh* session of someone who signs back in
within the same second as their own change, and a token issued in the same
second as the change is not a threat model worth that. The tests state the
window rather than leaving it to be discovered.

A missing `iat` counts as stale: a token we cannot date is one we cannot vouch
for.

### `lib/auth.ts` — the `jwt` callback

On sign-in (`user` present) it behaves as it does today. On every later call it
loads `passwordChangedAt` for `token.id` and returns `null` when
`isSessionStale` says so.

This adds a user lookup per session resolution. Accepted: many requests already
make one through `getSessionUser`, and correctness is the whole point of the
feature.

### `lib/password.ts` — one password rule

`lib/signup.ts` spells `z.string().min(8)` twice, and this change would make it
three. Extract the field so register, invite activation and change agree by
construction; reset-by-email becomes the fourth user.

### `PUT /api/account/password`

1. `getSessionUser()`, else 401 `notLoggedIn`.
2. Parse `{ currentPassword, newPassword }`; the new one uses the shared field.
3. `bcrypt.compare` the current password, exactly as
   `app/api/account/route.ts:38` does; mismatch answers 400 `wrongPassword`.
4. One `update` writing `passwordHash` and `passwordChangedAt` together.

It **sets** a hash and never clears one, so the invariant pinned in
`lib/admin-users.test.ts` by #52 continues to hold — the admin re-invite branch
still reads `passwordHash === null` as "invitation never redeemed".

`termsAcceptedAt` and `termsVersion` are not touched: changing a password is not
a new consent.

### `components/ChangePassword.tsx`

Beside `DeleteAccount` on `/my`. On success it signs out and sends the user to
`/login` with a notice. Copy in DE/EN/IT, including the new `errors.*` keys.

## Tests

- `isSessionStale`: before, after, exactly on the second boundary, a null
  `changedAt`, and a missing `iat`.
- The route: no session, wrong current password, a new password under the
  minimum, success stamping both columns, and that `termsAcceptedAt` is
  untouched.
- The shared password field, so the minimum has one definition and one test.
- The component: validation, the error surfaced from the route, and the
  sign-out on success.
- A pre-change token rejected and a post-change one accepted.

## Out of scope

Reset-by-email — the `PASSWORD_RESET` token kind and its TTL, `/forgot` and
`/reset`, the mail, rate limiting, enumeration-safety — stays in #42 (or its
successor) and reuses `passwordChangedAt` and `isSessionStale` unchanged.

Deleting outstanding `PASSWORD_RESET` tokens after a change is listed in #42's
"both paths"; there is no such token kind yet, so it belongs with the half that
introduces it.
