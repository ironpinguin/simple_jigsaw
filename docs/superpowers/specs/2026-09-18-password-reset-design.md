# Password reset by email — design

The second half of #42, built on `feat/change-password` (the first half, PR #89).
Forgetting a password is a dead end today: `lib/auth.ts` is the only place a
password is checked and there is no recovery path. The single workaround is an
admin re-invite, which is itself unreliable for existing accounts (#33).

Everything the first half built is reused unchanged: `passwordChangedAt`,
`isSessionStale`, `passwordField`, and the `jwt` callback that ends sessions.

## Decisions made during brainstorming

Two of these deviate from #42 as written. Both are deliberate and are called out
again where they bite.

- **Unverified accounts may reset, and completing a reset verifies them.** #42's
  scope restricts the mail to accounts that are *verified*; that is relaxed.
  Clicking a link sent to the mailbox proves exactly what the confirmation mail
  asks, so honouring it costs nothing and un-sticks someone who signed up, never
  confirmed, and then forgot their password — who today has no self-service
  route back at all. The consequence, stated plainly: **a reset is a second way
  through the confirmation gate.** Nobody gains access they should not, because
  the reset still requires control of the mailbox.
- **The reset link lives 2 hours.** #42 asked 1 or 2. Compare `EMAIL_VERIFY` at
  24 h and `INVITE` at 7 days: a recovery link is the most dangerous credential
  this system mails, because it grants an account outright, so it is much the
  shortest. Two rather than one buys tolerance for a greylisting delay or a slow
  relay; requesting another is one click either way.
- **Rate limiting is split in two, because the two halves defend different
  things.** See *Rate limiting* below. The durable half caps mail to real
  people; the in-memory half blunts probing.

## Eligibility

A mail goes out only for an account that **exists**, is **not banned**
(`checkEmailBanned`), and **has a `passwordHash`**.

The last rule is what keeps invited-but-never-activated rows on the invite flow
(#33): those have a null hash, and handing them a reset link would be a second,
quieter activation path. It is also the same predicate the admin re-invite
branch reads, so the two stay consistent — see the invariant test in
`lib/admin-users.test.ts`.

Verification is deliberately **not** required, per the decision above.

## The response never varies

`POST /api/account/password/reset-request` answers the same 200 body for every
input: unknown address, banned address, password-less row, rate-limited caller,
and success. Nothing in the status, body, or timing is allowed to distinguish
them.

That is the whole reason the endpoint can be public, and it is why the rate
limiter below cannot report that it fired.

## Rate limiting

There is no Redis. The repo already rate-limits by counting rows in a window —
`app/api/report/route.ts:42-46` counts `Report` rows on `reporterIpHash +
createdAt`, with constants in `lib/reports.ts:49-50`. This follows that.

**Durable half — counted from token rows.** `VerificationToken` already carries
`createdAt` and an index on `userId`; one new nullable column,
`requesterIpHash`, lets the same rows be counted per IP. Two limits:

- per email: recent `PASSWORD_RESET` rows for that user
- per IP: recent `PASSWORD_RESET` rows with that `requesterIpHash`

This caps **mail actually sent to real people**, survives restarts, and works
across replicas. It is the limit that matters, because sending mail is the
expensive, abusable side effect.

**In-memory half — a per-IP probe counter.** The durable half cannot see a
request for an address that does not exist, because such a request creates no
row. An attacker enumerating thousands of addresses would be counted zero times.
A small in-process counter therefore covers *every* request, including the ones
that produce nothing.

Losing it on restart, and its being per-replica, are both accepted: it guards
work, not secrets. The identical response above already means probing learns
nothing; this only stops it being free.

`hashReporterIp` (`lib/report-ip.ts`) is reused for the hash, and its
`TRUSTED_PROXY_HOPS` caveat applies here exactly as it does to reports: behind a
misconfigured proxy every caller may hash to the same value.

## Components

### `lib/token-ttl.ts` and `lib/roles.ts` — the new kind

`PASSWORD_RESET` joins `TokenKind` and `TOKEN_TYPES` (SQLite has no enums, so
the union in `lib/roles.ts` is where token types are declared) with a TTL of
2 hours. `createToken`, `consumeToken` and `revokeTokens` are already generic
over the kind, so single-use and expiry need no new code, and
`scripts/purge-expired.mjs` already sweeps on `expiresAt`.

### `prisma/schema.prisma`

```prisma
// Hashed with hashReporterIp, as Report.reporterIpHash is. Null for tokens
// created outside a request (invites, verification), and for rows that predate
// the column.
requesterIpHash String?
```

Nullable, indexed, no enum, no native types — it has to push on SQLite too.

### `lib/mail.ts`

`resetUrl(token, locale)` and `sendPasswordResetEmail`, mirroring `verifyUrl`
and `sendVerificationEmail` exactly, including the locale prefix.

### `POST /api/account/password/reset-request`

Probe counter, then eligibility, then per-email and per-IP token counts, then
`createToken`.

**It deliberately does not revoke the previous token, unlike the admin invite
route**, for two reasons.

The first is that revoking would break the rate limiter. `revokeTokens` deletes
the rows, and those same rows are what the durable limit counts — revoke on
every request and the per-email count can never exceed one, so the limit is
decorative. It would delete that user's rows from the per-IP count too.

The second is that the invite route's reasoning does not transfer. It revokes
because two live invitations can sit in two *different* mailboxes — an admin may
re-invite a different address for the same row. Every reset link for an account
goes to that account's own address, so extra links pile up in one inbox, the
inbox of the person who asked for them. The risk that argument guards against
is not present here.

What keeps that safe is the rest of the design rather than revocation: the links
are single-use (`consumeToken` deletes the row it claims), they live 2 hours,
and the rate limits cap how many can exist at all. A user who clicks the oldest
of three still gets exactly one reset.

Every branch returns the identical 200.

### `POST /api/account/password/reset`

`consumeToken(token, "PASSWORD_RESET")`, then **one** update writing
`passwordHash`, `passwordChangedAt` and `emailVerified` together. Stamping
`passwordChangedAt` is what makes a reset end every other session, reusing
`isSessionStale` untouched — which is what the first half's spec promised its
successor.

`termsAcceptedAt` / `termsVersion` are not touched: recovering a password is not
a new consent.

### `PUT /api/account/password` — a loose end from the first half

Now that the kind exists, the change route revokes outstanding
`PASSWORD_RESET` tokens on success, so a reset mail sitting in an inbox stops
being a second key to an account whose owner has just changed the password
deliberately. #42 lists this under *Both paths*; it could not be built before.

### Pages

`/[locale]/forgot` asks for an address and always shows the same confirmation.
`/[locale]/reset?token=…` sets the new password. Both modelled on
`app/[locale]/verify/page.tsx`, with a link added to the login form. Copy in
DE/EN/IT.

## Tests

- The new TTL, and that the kind is declared in both places.
- Eligibility: unknown, banned, password-less and verified-less addresses — the
  last now *succeeding* rather than being refused.
- That every branch returns a byte-identical body.
- Rate limiting: both durable counts, and the probe counter including the
  unknown-address case the durable half cannot see.
- Reset completion: single-use, expired, foreign and reused tokens; and that one
  update writes all three columns.
- That a session issued before a reset is refused afterwards.
- That a successful change revokes outstanding reset tokens.

## Out of scope

Everything the first half already shipped. Also: account lockout after repeated
failed logins, and any notification to the user that a reset was *requested* —
both reasonable, neither in #42.
