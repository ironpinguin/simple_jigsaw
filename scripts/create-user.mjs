// Create an active (email-verified) user or admin from the command line.
//
// In docker-compose (recommended, DATABASE_URL already set in the container):
//   docker compose exec app npm run create-user -- you@example.com 'password' [--admin]
//
// This is an operator action: it bypasses the ban list and marks the account
// verified so it can log in immediately.

import pkg from "../lib/generated/prisma/index.js";
import bcrypt from "bcryptjs";

const { PrismaClient } = pkg;

async function main() {
  const args = process.argv.slice(2);
  const admin = args.includes("--admin");
  const [email, password] = args.filter((a) => !a.startsWith("--"));

  if (!email || !password) {
    console.error("Usage: npm run create-user -- <email> <password> [--admin]");
    process.exit(1);
  }
  // Duplicated from lib/password-limits.ts, which is TypeScript and so cannot
  // be imported here — keep the two in step. The maximum is bcrypt's: it hashes
  // 72 bytes and ignores the rest, so a longer password would authenticate on
  // its first 72 bytes alone with nothing saying the tail was dropped.
  const PASSWORD_MIN_LENGTH = 8;
  const PASSWORD_MAX_BYTES = 72;

  if (password.length < PASSWORD_MIN_LENGTH) {
    console.error(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    );
    process.exit(1);
  }
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    console.error(
      `Password must be at most ${PASSWORD_MAX_BYTES} bytes — accented letters and emoji count for more than one.`,
    );
    process.exit(1);
  }

  const e = email.toLowerCase().trim();
  const prisma = new PrismaClient();
  try {
    if (await prisma.user.findUnique({ where: { email: e } })) {
      console.error(`A user with that email already exists: ${e}`);
      process.exit(1);
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: {
        email: e,
        passwordHash,
        role: admin ? "ADMIN" : "USER",
        emailVerified: new Date(),
      },
    });
    console.log(`✔ created ${admin ? "ADMIN" : "USER"}: ${e}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
