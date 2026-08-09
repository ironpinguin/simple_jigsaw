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

import { PrismaClient } from "./generated/prisma";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

globalForPrisma.prisma = prisma;
