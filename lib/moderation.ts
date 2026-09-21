// Server-side ban enforcement backed by the BannedEmail table.

import { prisma } from "./db";
import { normalizeEmail, domainOf } from "./bans";

/**
 * The slice of the Prisma client a ban check touches, so a caller inside
 * `prisma.$transaction` can hand over the transaction's own client rather than
 * making a second connection compete for the write lock it is holding (#50).
 */
export type ModerationDb = Pick<typeof prisma, "bannedEmail">;

/** True if the email address, or its domain, is on the ban list. */
export async function checkEmailBanned(email: string, db: ModerationDb = prisma): Promise<boolean> {
  const e = normalizeEmail(email);
  const d = domainOf(e);
  const hit = await db.bannedEmail.findFirst({
    where: {
      OR: [
        { type: "EMAIL", value: e },
        ...(d ? [{ type: "DOMAIN" as const, value: d }] : []),
      ],
    },
    select: { id: true },
  });
  return hit !== null;
}
