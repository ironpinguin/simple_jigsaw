// Promote an existing user to ADMIN.
//
// In docker-compose (recommended, DATABASE_URL already set in the container):
//   docker compose exec app npm run make-admin -- you@example.com
//
// On the host, provide DATABASE_URL yourself:
//   DATABASE_URL=postgresql://jigsaw:jigsaw@localhost:5432/jigsaw npm run make-admin -- you@example.com

import { createPrisma } from "./db-client.mjs";


async function main() {
  const email = (process.argv[2] ?? "").toLowerCase().trim();
  if (!email) {
    console.error("Usage: npm run make-admin -- <email>");
    process.exit(1);
  }

  const prisma = createPrisma();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user found with email: ${email}`);
      process.exit(1);
    }
    await prisma.user.update({ where: { email }, data: { role: "ADMIN" } });
    console.log(`✔ ${email} is now ADMIN`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
