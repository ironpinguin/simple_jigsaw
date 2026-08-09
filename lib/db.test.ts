import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { constructed } = vi.hoisted(() => ({ constructed: vi.fn() }));

vi.mock("./generated/prisma", () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      constructed(options);
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

    expect(constructed).toHaveBeenCalledWith({ log: ["error"] });
  });
});
