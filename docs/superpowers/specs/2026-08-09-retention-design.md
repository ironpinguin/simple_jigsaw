# Retention: expired tokens and ban entries — design

Issue: #20 (sub-issue of #2). Branch: `feat/token-retention`.

GDPR Art. 5(1)(e), storage limitation. Two tables grow without a defined
period: `VerificationToken` has an `expiresAt` that nothing ever acts on, and
`BannedEmail` holds addresses indefinitely. This closes the first and states a
period for the second.

## Decisions made during brainstorming

- **Bans stay indefinite**, justified by the abuse-prevention legitimate
  interest. No TTL, no per-entry expiry, no schema change — `legal.bansText`
  already words it that way ("for as long as the block is in place", Art.
  6(1)(f)), so the issue's "document why" bullet is met by the text that
  shipped with #16.
- **The sweep runs opportunistically from `createToken`**, plus an `npm run`
  script. The script alone would leave the bug in place on every instance that
  never sets up cron; the opportunistic call fixes the default deployment and
  is self-limiting, because the table only grows when tokens are issued.
- **No grace period.** A token past `expiresAt` has no purpose — `consumeToken`
  already refuses it — so keeping the row is holding personal data for nothing.

## Current state

Verified, not assumed: there is no `deleteMany` anywhere in `app/` or `lib/`,
and no scheduled job or startup hook. `consumeToken` deletes on redeem, so the
gap is exactly the unredeemed path. Expiry is only ever *checked*, in
`isExpired`.

## Components

### Selection logic — `lib/token-ttl.ts`

```ts
export function expiredTokenFilter(now: number): { expiresAt: { lt: Date } };
```

Pure, no DB, next to `isExpired` — the placement is the point. `isExpired`
compares with `<`, so a token whose `expiresAt` is exactly `now` is still
valid and must not be swept. The two functions have to agree on that boundary,
and the test asserts the agreement rather than restating the operator.

### Sweep — `lib/tokens.ts`

```ts
export async function purgeExpiredTokens(now = Date.now()): Promise<number>;
```

`deleteMany` with that filter, returning the count.

`createToken` calls it before inserting, with the failure swallowed the way
`consumeToken` already swallows its delete: a purge that fails must not turn a
registration or an invite into a 500. Purging before the insert also keeps the
row being created out of the sweep's scope entirely.

### Script — `scripts/purge-expired.mjs`

`npm run purge-expired`, same shape as `scripts/make-admin.mjs`: standalone
`PrismaClient`, print the count, disconnect. For instances that have been
running a while, and for operators who want a schedule instead of relying on
token issuance.

It cannot import `lib/token-ttl.ts` — the scripts are `.mjs`, the lib is TS —
so the one-line where clause is repeated there with a comment naming the source
of truth.

Documented in the README's admin section next to `make-admin`, with a compose
invocation.

### Policy — `messages/{de,en,it}.json`, `lib/legal.ts`

The policy currently discloses the gap, so implementing the purge means editing
it rather than adding to it. Both strings get shorter:

- `legal.tokensText` drops "but the entry itself stays until the account is
  deleted".
- `legal.retentionText` drops "an expired link that was never redeemed is not
  cleaned up automatically and goes away with the account".

Both become the statement that is now true: expired links are removed
automatically. `legal.bansText` is untouched.

`PRIVACY_UPDATED` moves to `2026-08-09`. It is a single constant formatted per
locale; `lib/messages.test.ts` fails if only one catalog gets edited.

## Tests

- `lib/token-ttl.test.ts` — the boundary agreement between `expiredTokenFilter`
  and `isExpired`.
- `lib/tokens.test.ts` — new, mocking `./db` the way `account-deletion.test.ts`
  does: `createToken` issues the purge, and a failing purge still creates the
  token.

## Out of scope

No admin UI, no HTTP endpoint, no schema change.
