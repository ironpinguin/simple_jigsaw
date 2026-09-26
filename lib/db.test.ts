import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { constructed, adapters } = vi.hoisted(() => ({
  constructed: vi.fn(),
  adapters: vi.fn(),
}));

// One double per generated client, tagged so a test can tell which one the
// module built — the whole point of choosing at boot is that it is the right one.
vi.mock("./generated/postgresql", () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      constructed("postgresql", options);
    }
  },
}));
vi.mock("./generated/sqlite", () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      constructed("sqlite", options);
    }
  },
}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: unknown, options?: unknown) {
      adapters("pg", config, options);
    }
  },
}));
vi.mock("@prisma/adapter-better-sqlite3", () => ({
  PrismaBetterSqlite3: class {
    constructor(config: unknown, options?: unknown) {
      adapters("better-sqlite3", config, options);
    }
  },
}));

const globalForPrisma = globalThis as unknown as { prisma?: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  // Both the module registry and the cache have to go, or a later test imports
  // the copy an earlier one already constructed.
  vi.resetModules();
  delete globalForPrisma.prisma;
  // Pinned rather than inherited, so a shell or container that exports
  // DATABASE_PROVIDER=sqlite runs the same tests. The tests about the choice
  // set their own.
  vi.stubEnv("DATABASE_PROVIDER", "postgresql");
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete globalForPrisma.prisma;
});

describe("the Prisma client singleton", () => {
  it("constructs one client per process, production included", async () => {
    // The cache used to be behind `NODE_ENV !== "production"`. Next emits this
    // module once per webpack layer, so in production that guard meant one
    // PrismaClient per layer: several connection pools against Postgres, and
    // on the SQLite stack several writers against a single file. Re-adding the
    // guard is a one-line change, and this is what catches it.
    vi.stubEnv("NODE_ENV", "production");

    const first = await import("./db");
    vi.resetModules();
    const second = await import("./db"); // stands in for another layer

    expect(constructed).toHaveBeenCalledTimes(1);
    expect(second.prisma).toBe(first.prisma);
  });

  it("logs queries no louder than errors outside development", async () => {
    // The DSN and token values travel in query logs; production must not.
    vi.stubEnv("NODE_ENV", "production");

    await import("./db");

    expect(constructed).toHaveBeenCalledWith(
      "postgresql",
      expect.objectContaining({ log: ["error"] }),
    );
  });
});

describe("choosing the database at boot", () => {
  it("builds the Postgres client with the pg adapter by default", async () => {
    vi.stubEnv("DATABASE_PROVIDER", "");
    delete process.env.DATABASE_PROVIDER;
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db:5432/jigsaw");

    await import("./db");

    expect(adapters).toHaveBeenCalledWith(
      "pg",
      expect.objectContaining({ connectionString: "postgresql://u:p@db:5432/jigsaw" }),
      { schema: undefined },
    );
    expect(constructed).toHaveBeenCalledWith("postgresql", expect.anything());
  });

  it("hands the pg adapter the URL's schema, which it would otherwise ignore", async () => {
    // `db push` honours ?schema= and creates the tables there; without the
    // option the adapter queries `public` and every query fails with P2021.
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db:5432/jigsaw?schema=puzzles");

    await import("./db");

    expect(adapters).toHaveBeenCalledWith("pg", expect.anything(), { schema: "puzzles" });
  });

  it("bounds the wait for a Postgres connection", async () => {
    // pg waits forever by default, for a connection and for a turn in the
    // pool; Prisma 6 gave up after seconds.
    await import("./db");

    expect(adapters).toHaveBeenCalledWith(
      "pg",
      expect.objectContaining({ connectionTimeoutMillis: expect.any(Number) }),
      expect.anything(),
    );
    const [, config] = adapters.mock.calls[0] as [string, { connectionTimeoutMillis: number }];
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("builds the SQLite client with the better-sqlite3 adapter for sqlite", async () => {
    // One image for both databases: nothing about the build decides this any
    // more, so a deployment that says sqlite must get the SQLite client.
    vi.stubEnv("DATABASE_PROVIDER", "sqlite");
    vi.stubEnv("DATABASE_URL", "file:/data/app.db");

    await import("./db");

    expect(adapters).toHaveBeenCalledWith(
      "better-sqlite3",
      { url: "file:/data/app.db" },
      expect.anything(),
    );
    expect(constructed).toHaveBeenCalledWith("sqlite", expect.anything());
    expect(constructed).toHaveBeenCalledTimes(1);
  });

  it("stores SQLite timestamps as epoch milliseconds, the way Prisma 6 did", async () => {
    // The adapter's default is ISO text. On a database Prisma 6 wrote, SQLite
    // sorts every old integer before any string, so `expiresAt < now` would
    // match every outstanding token and the sweep would delete them all.
    vi.stubEnv("DATABASE_PROVIDER", "sqlite");
    vi.stubEnv("DATABASE_URL", "file:/data/app.db");

    await import("./db");

    expect(adapters).toHaveBeenCalledWith("better-sqlite3", expect.anything(), {
      timestampFormat: "unixepoch-ms",
    });
  });

  it("accepts the provider in any case, as scripts/prisma.mjs does", async () => {
    vi.stubEnv("DATABASE_PROVIDER", "SQLite");

    await import("./db");

    expect(constructed).toHaveBeenCalledWith("sqlite", expect.anything());
  });

  it("refuses an unknown provider instead of guessing", async () => {
    // A typo would otherwise boot the Postgres client against a SQLite path,
    // and the first query would fail as if the database were down.
    vi.stubEnv("DATABASE_PROVIDER", "mysql");

    await expect(import("./db")).rejects.toThrow(/DATABASE_PROVIDER/);
    expect(constructed).not.toHaveBeenCalled();
  });
});

describe("the SQLite connection gate", () => {
  // A stand-in for the one better-sqlite3 connection, recording statements in
  // the order they reach it. Inside a transaction they are prefixed `tx:`.
  function fakeConnection() {
    const ran: string[] = [];
    const empty = { columnNames: [], columnTypes: [], rows: [] };
    const record = (entry: string) => {
      ran.push(entry);
    };
    const tx = {
      provider: "sqlite",
      adapterName: "fake",
      options: { usePhantomQuery: false },
      queryRaw: async ({ sql }: { sql: string }) => {
        record(`tx:${sql}`);
        return empty;
      },
      executeRaw: async ({ sql }: { sql: string }) => {
        record(`tx:${sql}`);
        return 1;
      },
      commit: async () => record("commit"),
      rollback: async () => record("rollback"),
    };
    const connection = {
      provider: "sqlite",
      adapterName: "fake",
      queryRaw: async ({ sql }: { sql: string }) => {
        record(sql);
        return empty;
      },
      executeRaw: async ({ sql }: { sql: string }) => {
        record(sql);
        return 1;
      },
      executeScript: async (script: string) => record(script),
      startTransaction: vi.fn(async () => {
        record("begin");
        return tx;
      }),
      dispose: async () => {},
    };
    return { ran, connection };
  }
  const query = (sql: string) => ({ sql, args: [], argTypes: [] });

  it("holds a query from outside until the open transaction has rolled back", async () => {
    // The bug this exists for: on one shared connection the outside write ran
    // inside the transaction and was rolled back with it, after its caller
    // had been told it succeeded.
    const { serializeSqliteTransactions } = await import("./db");
    const { ran, connection } = fakeConnection();
    const db = serializeSqliteTransactions(connection as never);

    const tx = await db.startTransaction();
    const outside = db.executeRaw(query("INSERT other"));
    await tx.executeRaw(query("INSERT mine"));
    await tx.rollback();
    await outside;

    expect(ran).toEqual(["begin", "tx:INSERT mine", "rollback", "INSERT other"]);
  });

  it("starts the next transaction only once the last one has committed", async () => {
    const { serializeSqliteTransactions } = await import("./db");
    const { ran, connection } = fakeConnection();
    const db = serializeSqliteTransactions(connection as never);

    const first = await db.startTransaction();
    const second = db.startTransaction();
    const read = db.queryRaw(query("SELECT"));
    await first.commit();
    await (await second).commit();
    await read;

    // The read queued behind both: the second transaction was waiting first.
    expect(ran).toEqual(["begin", "commit", "begin", "commit", "SELECT"]);
  });

  it("opens again when a transaction fails to start", async () => {
    const { serializeSqliteTransactions } = await import("./db");
    const { ran, connection } = fakeConnection();
    connection.startTransaction.mockRejectedValueOnce(new Error("busy"));
    const db = serializeSqliteTransactions(connection as never);

    await expect(db.startTransaction()).rejects.toThrow("busy");
    await db.executeRaw(query("INSERT after"));

    expect(ran).toEqual(["INSERT after"]);
  });
});
