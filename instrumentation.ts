// Next calls register() once when the server starts.
//
// The retention sweep must not depend on anyone configuring a probe: an
// operator running the image with a compose file of their own still gets the
// deletion the privacy policy promises. The readiness endpoint and createToken
// call the same throttled function, so all three stay within one sweep per
// hour per process.

export async function register() {
  // The edge runtime has no Prisma client and no long-lived process to hold a
  // timer; only the Node.js server runtime should schedule anything.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The scheduling itself lives in lib/ so the tests can reach it — this file
  // is outside every project in vitest.config.ts.
  const { startRetentionSweeps } = await import("@/lib/retention");
  startRetentionSweeps();
}
