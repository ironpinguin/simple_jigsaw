// Prisma client singleton, cached on globalThis.
//
// In dev, Next.js re-evaluates modules on every change, so caching avoids
// exhausting connections across reloads. In production, this module is also
// emitted once per webpack layer — instrumentation.ts, the route handlers and
// the server components each get their own copy with a distinct module id — so
// without the cache each layer would construct its own PrismaClient: several
// connection pools per process, and on the SQLite stack several writers
// against one file. Caching on globalThis, which every layer shares, is what
// keeps it to one client. Observed in .next/server as duplicate emitted copies
// of this module, not merely inferred; lib/db.test.ts pins the count.
//
// The provider is chosen at boot from DATABASE_PROVIDER, not at build time:
// scripts/prisma.mjs generates a client for each, and Prisma 7 needs a driver
// adapter to match. A Prisma client is still bound to one provider, so one
// image carries both and constructs only the one it is told to.

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient as PostgresClient } from "./generated/postgresql";
import { PrismaClient as SqliteClient, type Prisma } from "./generated/sqlite";

/**
 * The client as the app sees it, typed as the SQLite one on purpose. Its query
 * API is a strict subset of the Postgres client's — Postgres adds `mode` on
 * string filters, `skipDuplicates` and field references in list filters — so
 * code that compiles against it runs on both, which is what one image
 * serving either database needs. Typed as Postgres, a `mode: "insensitive"`
 * would compile and then throw on every SQLite install.
 */
export type Db = SqliteClient;

/** The client `$transaction` hands its callback. See `Db` for the choice of type. */
export type DbTransaction = Prisma.TransactionClient;

const PROVIDERS = ["postgresql", "sqlite"] as const;
type Provider = (typeof PROVIDERS)[number];

/**
 * Read at boot and refused if unknown, rather than falling back: an image
 * pointed at the wrong kind of database would otherwise come up and fail on
 * its first query, in a way the readiness probe reports as the database being
 * down rather than as a typo in the deployment.
 */
export function databaseProvider(): Provider {
  const raw = (process.env.DATABASE_PROVIDER ?? "postgresql").toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`DATABASE_PROVIDER must be one of ${PROVIDERS.join(", ")}, not "${raw}"`);
  }
  return raw as Provider;
}

function createClient(): Db {
  const url = process.env.DATABASE_URL ?? "";
  const log: Prisma.LogLevel[] =
    process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"];

  if (databaseProvider() === "sqlite") {
    // `file:` URLs resolve against the working directory, which in the image
    // is /app; the compose stack uses an absolute path on its volume.
    return new SqliteClient({ adapter: new PrismaBetterSqlite3({ url }), log });
  }
  // Cast across the two generated classes: structurally the Postgres client
  // accepts everything `Db` can express. See `Db`.
  return new PostgresClient({
    adapter: new PrismaPg({ connectionString: url }),
    log,
  }) as unknown as Db;
}

const globalForPrisma = globalThis as unknown as { prisma?: Db };

export const prisma = globalForPrisma.prisma ?? createClient();

globalForPrisma.prisma = prisma;
