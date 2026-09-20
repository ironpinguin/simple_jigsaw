// Pinging admins about a report that just landed in the moderation queue.
//
// Server-only (Prisma + SMTP), which is why it is not in lib/reports.ts: that
// module stays pure so client components can import the category lists. Same
// split as lib/report-ip.ts.

import { prisma } from "./db";
import { sendAutoReportNotification, sendReportNotification } from "./mail";
import type { ReportCategory } from "./reports";

/** Who filed the report — a person via /api/report, or the classifier itself. */
export type ReportOrigin = "user" | "machine";

// The log tag an operator greps, and the wording the mail uses. Both keyed off
// one value so the two paths cannot drift into notifying differently by
// accident, which is how the machine path came to notify nobody at all.
const LOG_TAG: Record<ReportOrigin, string> = { user: "report", machine: "nsfw" };
const NOTIFY: Record<ReportOrigin, typeof sendReportNotification> = {
  user: sendReportNotification,
  machine: sendAutoReportNotification,
};

/**
 * Tell every admin that a report is waiting.
 *
 * Shared by both writers of a Report. The machine path originally had no
 * notification at all: the uploader was told to wait for a review while nobody
 * had been told to perform one — in the case where the content is most likely
 * to actually be bad, and the only one where a user is blocked until an admin
 * acts.
 *
 * Total by construction, and callers rely on it. The queue is the source of
 * truth and the mail is only a ping, so a reporter must not be told their
 * report failed because SMTP was down, and an uploader must not lose a puzzle
 * that was already created and correctly held. Both call sites run this after
 * their write has committed, so a throw here would report failure for work that
 * actually succeeded.
 */
export async function notifyAdminsOfReport(
  puzzleTitle: string,
  category: ReportCategory,
  origin: ReportOrigin,
): Promise<void> {
  const tag = LOG_TAG[origin];
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { email: true, locale: true },
    });

    if (admins.length === 0) {
      // Without this line the no-admins case is indistinguishable from success,
      // and reports queue up unseen indefinitely.
      console.error(`[${tag}] no ADMIN users to notify — the report will sit unseen in the queue`);
      return;
    }

    const send = NOTIFY[origin];
    await Promise.all(
      admins.map((admin) =>
        // Each admin in their own language: the reporter's locale belongs to
        // somebody else entirely, and the acting admin's does on the machine
        // path too — there is no acting admin there at all.
        send(admin.email, puzzleTitle, category, admin.locale).catch((error: unknown) => {
          // Per recipient, so one full mailbox does not cost the other admins
          // their notification.
          console.error(`[${tag}] admin notification to ${admin.email} failed:`, error);
        }),
      ),
    );
  } catch (error) {
    // The admin lookup itself can fail, and Promise.all above cannot reject
    // (every send has its own catch) — so this is the database, not the mail.
    console.error(`[${tag}] could not notify admins:`, error);
  }
}
