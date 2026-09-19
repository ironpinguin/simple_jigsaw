// Rate limiting for password reset, in two halves that defend different things.
//
// The durable half lives in the database: the request route counts recent
// PASSWORD_RESET rows per user and per requesting IP, the same shape
// app/api/report/route.ts uses for reports. That caps mail actually sent to
// real people, survives a restart, and works across replicas.
//
// This file is the other half. The durable count cannot see a request for an
// address that does not exist, because such a request creates no row — so
// somebody enumerating addresses would be counted zero times. `recordProbe`
// counts *every* request, including the ones that produce nothing.
//
// It is in-process on purpose. Losing it on restart, and its being per-replica,
// are acceptable because it guards work rather than secrets: the request
// endpoint answers identically whatever happens, so probing learns nothing
// either way. This only stops it being free.
//
// PROBE_LIMIT is keyed by ipHash, and hashReporterIp collapses every visitor to
// one shared "unknown" bucket on a deployment with no trusted proxy (the
// shipped default — see lib/report-ip.ts). Enforcing it there would make it
// exactly the deployment-wide lever RESET_PER_IP_LIMIT would be if the request
// route consulted it in that configuration: one caller sustaining a low,
// steady rate keeps the shared bucket permanently full, `recordProbe` then
// returns false for everybody, and — because the response never varies —
// password recovery goes silently dead site-wide for as long as they keep
// going. No number fixes that: raising PROBE_LIMIT only raises how long it
// takes one caller to fill a bucket everybody else also has to share.
//
// So the request route records into this counter unconditionally, to keep it
// warm, but enforces it only when hasTrustedProxy() (lib/report-ip.ts) says the
// hash identifies one real client — the same gate that route already applies
// to the durable per-IP count, for the same reason. Without a trusted proxy
// this file protects nothing on its own; what does the work in that
// configuration is the per-email cap below (RESET_PER_EMAIL_LIMIT, 3/hour),
// unconditional because it is keyed on the address rather than on an IP an
// attacker can collapse. Leaving requests for non-existent addresses unmetered
// there is an acceptable cost — each one is a couple of queries and no mail
// sent — and the generic load concern that remains belongs at a real trusted
// proxy, not a reason to hand any single caller a lever over everyone's
// password recovery.

/** Per account, per window. One person recovering one account needs very few. */
export const RESET_PER_EMAIL_LIMIT = 3;

/** Per requesting IP, per window — an office may hold several real people. */
export const RESET_PER_IP_LIMIT = 10;

export const RESET_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * How stale an account's newest reset link has to be for a request to be
 * honoured even though RESET_PER_EMAIL_LIMIT is spent.
 *
 * Without this, the per-address cap is a lever anyone can hold over somebody
 * else's account. The endpoint is public and its answer never varies, so three
 * POSTs naming a victim's address spend that victim's whole hourly budget; three
 * more an hour later keep it spent for as long as the attacker cares to
 * continue. The victim then asks to reset, is told a link is on its way, and
 * never receives one — no error, nothing to explain it. The attacker's own
 * requests do mail working links to the victim's address, which is the only
 * reason this is not a total lockout, but a link that landed in spam or was
 * deleted as unsolicited is no recovery path.
 *
 * A quota alone cannot tell the two apart, because both sides have exactly the
 * same evidence: an address. What it can do is bound how long the account can be
 * held shut. Once the newest link for the account is this old, one more request
 * is let through whatever the count says — so the wait is at most this interval
 * rather than unbounded, and an attacker has to win the race afresh every time.
 *
 * Window over limit, so the long-run ceiling this relaxes to is the rate the
 * quota already allows in a burst: three per hour becomes one per twenty
 * minutes, and the worst case is the two together, roughly five mails an hour
 * to one address. That is the price of the guarantee, paid in mail to an
 * address that asked for it.
 *
 * Purely a relaxation: it only ever lets through a request the quota would have
 * dropped, so nothing that worked before can start failing because of it.
 */
export const RESET_EMAIL_RETRY_AFTER_MS = RESET_RATE_WINDOW_MS / RESET_PER_EMAIL_LIMIT;

/**
 * Every request from one hashed IP, existing address or not — enforced only
 * when hasTrustedProxy() confirms the hash identifies a single real client.
 */
export const PROBE_LIMIT = 60;
export const PROBE_WINDOW_MS = 10 * 60 * 1000;

/** ipHash -> timestamps within the current window. */
const probes = new Map<string, number[]>();

/** When the last full sweep ran, so the next one can be due rather than constant. */
let lastSweepAt = 0;

/** How many full sweeps have run. Test seam: the cadence is the point, below. */
let sweeps = 0;

/**
 * Drop every bucket with nothing live left in it. O(callers seen recently), so
 * it runs at most once per window rather than once per call — see `recordProbe`.
 */
function sweep(cutoff: number, now: number): void {
  for (const [key, times] of probes) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) probes.delete(key);
    else probes.set(key, live);
  }
  lastSweepAt = now;
  sweeps++;
}

/**
 * Record one request from `ipHash` and say whether it is allowed.
 *
 * Prunes as it goes: without that, every address that ever probed would be held
 * until the process restarted. The caller's own bucket is pruned on every call,
 * which is what the limit is actually read from; the rest of the map is swept
 * only when a sweep is due.
 *
 * The cadence is the point. Sweeping the whole map on every call makes one
 * request cost O(callers seen in the last ten minutes) — and behind a trusted
 * proxy, the only configuration where this counter is enforced at all, a prober
 * spread over N source addresses is exactly what fills that map. The limiter
 * would then do O(N²) work over the run: the mechanism that exists to make
 * enumeration expensive for the attacker, doing the attacker's work for them on
 * an unauthenticated endpoint. Sweeping once per window keeps the map bounded by
 * the callers of the last two windows and leaves each request O(1) in its own
 * bucket.
 */
export function recordProbe(ipHash: string, now: number = Date.now()): boolean {
  const cutoff = now - PROBE_WINDOW_MS;

  if (now - lastSweepAt >= PROBE_WINDOW_MS) sweep(cutoff, now);

  const mine = (probes.get(ipHash) ?? []).filter((t) => t > cutoff);
  if (mine.length >= PROBE_LIMIT) {
    probes.set(ipHash, mine);
    return false;
  }
  mine.push(now);
  probes.set(ipHash, mine);
  return true;
}

/** Test seam: the counter is module state, so tests need a way to clear it. */
export function __resetProbeState(): void {
  probes.clear();
  lastSweepAt = 0;
  sweeps = 0;
}
__resetProbeState.size = () => probes.size;
__resetProbeState.sweeps = () => sweeps;
