---
name: db-change
description: Use when editing prisma/schema.prisma or anything about persistence in this repo — adding a model or column, changing a type, or touching role/status values.
---

# Changing the database schema

`prisma/schema.prisma` is the **single source of truth**, committed with
`provider = "postgresql"`. Every schema change must work on **both** providers.

## How the two providers work

`scripts/prisma.mjs` derives `prisma/.sqlite.prisma` from the committed schema
with only the datasource `provider` and the generator `output` swapped. That
derived file is gitignored — never edit or commit it, and never add a second
schema file.

- `generate` always builds **both** clients: `lib/generated/postgresql` and
  `lib/generated/sqlite`. One image serves either database; `lib/db.ts` picks
  the client and its driver adapter from `DATABASE_PROVIDER` at boot.
- Every other command (`db push`, …) runs against the provider
  `DATABASE_PROVIDER` names (`postgresql` default, or `sqlite`).
- The connection URL is not in the schema (Prisma 7 refuses it): the CLI reads
  `DATABASE_URL` through `prisma.config.ts`, the app hands it to the adapter.

```bash
npm run db:push       # node scripts/prisma.mjs db push
npm run db:generate   # node scripts/prisma.mjs generate  (both clients)
```

The app is typed against the **SQLite** client (`Db` in `lib/db.ts`), whose
query API is a subset of the Postgres one. A Postgres-only option such as
`mode: "insensitive"` or `skipDuplicates` therefore fails the typecheck instead
of the SQLite install.

There are **no committed migrations**. The dev container runs `prisma db push`
on boot, and the images do the same — so `db push` is the mechanism, and
`prisma:migrate` in package.json is not part of the normal flow. A destructive
change (dropped column, narrowed type) therefore hits existing dev databases
without a migration to review: call that out explicitly instead of pushing it
quietly.

## The SQLite constraints

- **No Prisma `enum`.** Enumerated columns are `String` with the allowed values
  as a comment above them, plus a `const … as const` union in `lib/roles.ts`
  (`ROLES`, `TOKEN_TYPES`, `BAN_TYPES`) and validation in application code. Add
  new value sets there, the same way.
- **No native database arrays or JSON-specific types.** Model a list as a
  relation.
- `@db.*` native type attributes are Postgres-only — leave them out.

## Recipe

1. Edit `prisma/schema.prisma`. For an enumerated column: `String` + comment +
   union in `lib/roles.ts`.
2. `npm run db:generate` — both clients land in `lib/generated/postgresql` and
   `lib/generated/sqlite`
   (gitignored; `postinstall` regenerates it).
3. Push and exercise on **both** providers:
   ```bash
   DATABASE_PROVIDER=postgresql npm run db:push
   DATABASE_PROVIDER=sqlite     npm run db:push
   ```
   In containers: `docker compose exec app npm run db:push`, and the same in the
   SQLite stack (`-f docker-compose.sqlite.yml`).
4. `npm test` and `npm run build` — the generated client is typed, so a rename
   surfaces as a typecheck error across `lib/` and `app/api/`.
5. Changelog bullet if the change is user-visible.

## Common mistakes

- **Adding a Prisma `enum`.** Generates fine on Postgres, breaks the SQLite
  client — and `db:generate` builds both, so it fails every build.
- **Editing `prisma/.sqlite.prisma`.** It is regenerated on every run; the edit
  vanishes.
- **A required column without a default** on a table that already has rows —
  `db push` will offer to reset the data. Add a default or make it optional.
- **Only testing Postgres.** SQLite installs run the same released image
  (`DATABASE_PROVIDER=sqlite`, also tagged `:latest-sqlite`); they are not a
  side experiment.
