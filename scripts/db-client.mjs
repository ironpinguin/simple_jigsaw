// The Prisma client for the maintenance scripts, built the way lib/db.ts
// builds the app's: the generated client for DATABASE_PROVIDER, with the
// driver adapter Prisma 7 requires and the same adapter options. Repeated
// rather than imported because these scripts are plain ESM and cannot load the
// TypeScript module — keep the two in step.
//
// No transaction gate as in lib/db.ts: a script is one caller, with nothing
// running beside it on its connection.

import postgres from "../lib/generated/postgresql/index.js";
import sqlite from "../lib/generated/sqlite/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// Prisma 6's client read .env by itself and Prisma 7's does not, so on the
// host these scripts would otherwise lose the DATABASE_URL (and provider)
// kept there. Variables already set win, as in prisma.config.ts.
try {
  process.loadEnvFile();
} catch {}

/** See postgresSchema() in lib/db.ts: the pg adapter ignores `?schema=`. */
function postgresSchema(url) {
  try {
    return new URL(url).searchParams.get("schema") ?? undefined;
  } catch {
    return undefined;
  }
}

export function createPrisma() {
  const provider = (process.env.DATABASE_PROVIDER ?? "postgresql").toLowerCase();
  const url = process.env.DATABASE_URL ?? "";
  if (provider !== "sqlite" && provider !== "postgresql") {
    throw new Error(`DATABASE_PROVIDER must be one of postgresql, sqlite, not "${provider}"`);
  }
  // better-sqlite3 would open a throwaway in-memory database, and pg would
  // fall back to libpq's defaults: neither is the database the operator meant.
  if (!url) throw new Error("DATABASE_URL is not set");

  if (provider === "sqlite") {
    // Epoch milliseconds, as Prisma 6 stored them — see sqliteAdapter() in
    // lib/db.ts for what ISO text does to date comparisons on old rows.
    return new sqlite.PrismaClient({
      adapter: new PrismaBetterSqlite3({ url }, { timestampFormat: "unixepoch-ms" }),
    });
  }
  return new postgres.PrismaClient({
    adapter: new PrismaPg(
      { connectionString: url, connectionTimeoutMillis: 10_000 },
      { schema: postgresSchema(url) },
    ),
  });
}
