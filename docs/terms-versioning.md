# Terms of use: versioning and later changes

Decision for issue #17 — how a change to the terms of use is handled after
launch.

## What is stored

Every acceptance lands on the `User` row:

- `termsAcceptedAt` — when the user accepted.
- `termsVersion` — which text they accepted, as the ISO date of the version
  (`TERMS_VERSION` in `lib/legal.ts`, the same date rendered on
  `/legal/terms`).

Both are set at public registration (`app/api/register/route.ts`) and at
invite activation (`app/api/invite/route.ts`). `NULL` in both columns means
no recorded acceptance, which today covers three kinds of accounts:

- created before the terms existed,
- created by an admin — through the CLI (`scripts/create-user.mjs`) or the
  direct-create endpoint (`app/api/admin/users/route.ts`); an admin cannot
  accept on the user's behalf,
- invited but not yet activated (the row exists from the moment the admin
  sends the invite).

The re-accept flow below treats `NULL` as outdated, so all of them are asked
once it exists.

## Decision: re-accept on next login

When the terms text changes in a way that matters (new prohibitions, changed
liability, anything a user could reasonably object to):

1. Bump `TERMS_VERSION` in `lib/legal.ts` to the new date.
2. Ship a login interstitial that compares `User.termsVersion` against
   `TERMS_VERSION` and asks for acceptance before the session continues.
   `NULL` counts as outdated. This interstitial does not exist yet — it is
   built together with the first real terms change.

Notification-only was rejected: the terms are the legal basis for removing
content and accounts, so an operator needs every active user on the current
text. A purely editorial fix (typo, clearer wording, translation fix) does
not bump `TERMS_VERSION` and triggers nothing.

The terms page states this behaviour (`legal.termsChangesText`), so re-asking
at login is something users have already agreed to.
