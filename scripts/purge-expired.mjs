// Delete verification and invite tokens that are past their expiry
// (GDPR Art. 5(1)(e), storage limitation).
//
// The app already sweeps itself — at startup, hourly, and on every readiness
// check, throttled to once an hour across all three (lib/retention.ts) — so a
// running container needs no scheduling. This script is for the one-off
// catch-up against a database the app isn't currently running against (a
// backup restore, a migration), and for operators who would still rather
// drive the cleanup from their own scheduler than trust the container's.
//
// In docker-compose (recommended, DATABASE_URL already set in the container):
//   docker compose exec app npm run purge-expired
//
// On the host, provide DATABASE_URL yourself:
//   DATABASE_URL=postgresql://jigsaw:jigsaw@localhost:5432/jigsaw npm run purge-expired

import pkg from "../lib/generated/prisma/index.js";

const { PrismaClient } = pkg;

async function main() {
  const prisma = new PrismaClient();
  try {
    // Mirrors expiredTokenFilter() in lib/token-ttl.ts, which is the source of
    // truth for the boundary — repeated because this file is plain ESM and
    // cannot import the TypeScript module. `lt`, not `lte`: a token expiring
    // exactly now is still redeemable.
    const { count } = await prisma.verificationToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    console.log(`✔ removed ${count} expired token${count === 1 ? "" : "s"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
