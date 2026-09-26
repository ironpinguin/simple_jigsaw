// Prisma CLI configuration. Since Prisma 7 the connection URL no longer lives in
// the schema: the CLI (db push, studio, migrate) reads it from here, and the app
// hands it to a driver adapter in lib/db.ts.
//
// Which schema, and so which provider, is scripts/prisma.mjs's call — it passes
// `--schema` for SQLite. This file only says where the database is, which is the
// same variable for both providers.

import { defineConfig } from "prisma/config";

// Prisma 7 no longer reads .env by itself. Next does for the app, and the
// containers set the variables directly, so this only matters for a CLI run on
// the host. No file is not an error.
try {
  process.loadEnvFile();
} catch {}

export default defineConfig({
  schema: "prisma/schema.prisma",
  // Optional rather than `env("DATABASE_URL")`, which throws when unset:
  // `prisma generate` needs no database, and the image build runs it without one.
  datasource: { url: process.env.DATABASE_URL },
});
