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
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
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
