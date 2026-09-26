// The Prisma client for the maintenance scripts, built the way lib/db.ts
// builds the app's: the generated client for DATABASE_PROVIDER, with the
// driver adapter Prisma 7 requires. Repeated rather than imported because
// these scripts are plain ESM and cannot load the TypeScript module — keep the
// two in step.

import postgres from "../lib/generated/postgresql/index.js";
import sqlite from "../lib/generated/sqlite/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

export function createPrisma() {
  const provider = (process.env.DATABASE_PROVIDER ?? "postgresql").toLowerCase();
  const url = process.env.DATABASE_URL ?? "";
  if (provider === "sqlite") {
    return new sqlite.PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  }
  if (provider === "postgresql") {
    return new postgres.PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }
  throw new Error(`DATABASE_PROVIDER must be one of postgresql, sqlite, not "${provider}"`);
}
