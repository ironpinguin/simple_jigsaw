// Server-side ban enforcement backed by the BannedEmail table.

import { prisma } from "./db";
import { normalizeEmail, domainOf } from "./bans";

/** True if the email address, or its domain, is on the ban list. */
export async function checkEmailBanned(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const d = domainOf(e);
  const hit = await prisma.bannedEmail.findFirst({
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
