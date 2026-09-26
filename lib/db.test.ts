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
    constructor(config: unknown) {
      adapters("pg", config);
    }
  },
}));
vi.mock("@prisma/adapter-better-sqlite3", () => ({
  PrismaBetterSqlite3: class {
    constructor(config: unknown) {
      adapters("better-sqlite3", config);
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

    expect(adapters).toHaveBeenCalledWith("pg", {
      connectionString: "postgresql://u:p@db:5432/jigsaw",
    });
    expect(constructed).toHaveBeenCalledWith("postgresql", expect.anything());
  });

  it("builds the SQLite client with the better-sqlite3 adapter for sqlite", async () => {
    // One image for both databases: nothing about the build decides this any
    // more, so a deployment that says sqlite must get the SQLite client.
    vi.stubEnv("DATABASE_PROVIDER", "sqlite");
    vi.stubEnv("DATABASE_URL", "file:/data/app.db");

    await import("./db");

    expect(adapters).toHaveBeenCalledWith("better-sqlite3", { url: "file:/data/app.db" });
    expect(constructed).toHaveBeenCalledWith("sqlite", expect.anything());
    expect(constructed).toHaveBeenCalledTimes(1);
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
