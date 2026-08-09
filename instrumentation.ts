// Next calls register() once when the server starts.
//
// The retention sweep must not depend on anyone configuring a probe: an
// operator running the image with a compose file of their own still gets the
// deletion the privacy policy promises. The readiness endpoint calls the same
// throttled function, so the two together stay within one sweep per hour.

export async function register() {
  // The edge runtime has no Prisma client and no long-lived process to hold a
  // timer; only the Node.js server runtime should schedule anything.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { maybePurgeExpiredTokens, SWEEP_INTERVAL_MS } = await import("@/lib/retention");

  // Not awaited: startup must not wait on the database, and the function
  // handles its own failures.
  void maybePurgeExpiredTokens();

  // unref, so housekeeping is never the reason the process stays alive.
  setInterval(() => void maybePurgeExpiredTokens(), SWEEP_INTERVAL_MS).unref();
}
