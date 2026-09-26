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

type SqliteConnection = Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;

/**
 * better-sqlite3 is a single connection, and the adapter queues transactions
 * only against each other. A query from outside a transaction runs on that
 * same connection, so it runs *inside* whichever interactive transaction is
 * open: it reads that transaction's uncommitted writes, and when the
 * transaction rolls back — a refused token claim does, by design — its own
 * write goes with it, although its caller was told it succeeded. Prisma 6's
 * engine never ran another request's query on a transaction's connection.
 *
 * So a query from outside waits until no transaction is open, and so does the
 * next transaction. Transactions here are short on purpose (mail and storage
 * I/O stay outside them), and Prisma's own `timeout` ends any that is not.
 * Exported for lib/db.test.ts.
 */
export function serializeSqliteTransactions(connection: SqliteConnection): SqliteConnection {
  let open = false;
  let closed: Promise<void> = Promise.resolve();

  async function whenIdle<T>(run: () => Promise<T>): Promise<T> {
    // A loop rather than one await: every waiter wakes on the same close, and
    // a transaction among them may reopen the gate before the rest run.
    while (open) await closed;
    // Called in the same tick as the check, and better-sqlite3 executes the
    // statement synchronously inside the call, so nothing can slip a BEGIN in
    // between.
    return run();
  }

  return {
    provider: connection.provider,
    adapterName: connection.adapterName,
    queryRaw: (query) => whenIdle(() => connection.queryRaw(query)),
    executeRaw: (query) => whenIdle(() => connection.executeRaw(query)),
    executeScript: (script) => whenIdle(() => connection.executeScript(script)),
    getConnectionInfo: connection.getConnectionInfo?.bind(connection),
    dispose: () => connection.dispose(),
    async startTransaction(isolationLevel) {
      while (open) await closed;
      open = true;
      let release = () => {};
      closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        open = false;
        release();
      };

      const tx = await connection.startTransaction(isolationLevel).catch((error: unknown) => {
        end();
        throw error;
      });
      // Prisma always finishes with commit() or rollback(), after it has sent
      // the COMMIT or ROLLBACK itself — also for a transaction it gave up
      // waiting for — so those two are where the gate opens again.
      return {
        provider: tx.provider,
        adapterName: tx.adapterName,
        options: tx.options,
        queryRaw: (query) => tx.queryRaw(query),
        executeRaw: (query) => tx.executeRaw(query),
        createSavepoint: tx.createSavepoint?.bind(tx),
        rollbackToSavepoint: tx.rollbackToSavepoint?.bind(tx),
        releaseSavepoint: tx.releaseSavepoint?.bind(tx),
        commit: () => tx.commit().finally(end),
        rollback: () => tx.rollback().finally(end),
      };
    },
  };
}

function sqliteAdapter(url: string) {
  // Epoch milliseconds, which is how Prisma 6 stored DateTime on SQLite; the
  // adapter's default is ISO text. SQLite orders every integer before every
  // string, so on a database Prisma 6 wrote, ISO parameters would make each
  // `lt: new Date()` match every old row and each `gte` none of them — every
  // outstanding link expired at once, and swept.
  const factory = new PrismaBetterSqlite3({ url }, { timestampFormat: "unixepoch-ms" });
  return {
    provider: "sqlite" as const,
    adapterName: factory.adapterName,
    async connect() {
      // better-sqlite3 opens an anonymous in-memory database for an empty
      // path: an unset DATABASE_URL would come up fine and keep nothing.
      // Checked here, on first use, because `next build` imports this module
      // without a database.
      if (!url) throw new Error("DATABASE_URL is not set");
      return serializeSqliteTransactions(await factory.connect());
    },
  };
}

/**
 * The `?schema=` of a Postgres URL. The Prisma CLI honours it, so `db push`
 * creates the tables there; the pg adapter ignores it and has to be told, or
 * the app would query `public` and find nothing. Absent means `public`.
 */
function postgresSchema(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("schema") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long a query waits for a Postgres connection, new or from the full pool.
 * pg's default is forever; Prisma 6 gave up after 5 s (connect) and 10 s
 * (pool), so an unreachable database was an error a route could answer rather
 * than a request that hangs.
 */
const PG_CONNECTION_TIMEOUT_MS = 10_000;

function createClient(): Db {
  const url = process.env.DATABASE_URL ?? "";
  const log: Prisma.LogLevel[] =
    process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"];

  if (databaseProvider() === "sqlite") {
    // `file:` URLs resolve against the working directory, which in the image
    // is /app; the compose stack uses an absolute path on its volume.
    return new SqliteClient({ adapter: sqliteAdapter(url), log });
  }
  // Cast across the two generated classes: structurally the Postgres client
  // accepts everything `Db` can express. See `Db`.
  return new PostgresClient({
    adapter: new PrismaPg(
      { connectionString: url, connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS },
      { schema: postgresSchema(url) },
    ),
    log,
  }) as unknown as Db;
}

const globalForPrisma = globalThis as unknown as { prisma?: Db };

export const prisma = globalForPrisma.prisma ?? createClient();

globalForPrisma.prisma = prisma;
