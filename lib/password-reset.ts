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
//
// Even behind a trusted proxy, a per-IP counter only holds a caller who stays
// on one address. One who rotates (a routed IPv6 /64 is 2^64 of them) gets a
// fresh bucket per address and sidesteps PROBE_LIMIT and RESET_PER_IP_LIMIT
// alike. That is inherent in keying on an address and is the trusted proxy's
// job to stop; what this file does make sure of is that such a caller cannot
// also make the counter expensive for everybody else — see `recordProbe`.

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

/**
 * Most distinct callers held at once. Behind a trusted proxy a client with a
 * routed IPv6 /64 has 2^64 source addresses, so without a cap the key count is
 * whatever that client decides it is. At roughly two hundred bytes a bucket,
 * its 64-character hash key included, this is about two megabytes, and far
 * above the distinct callers of one window that real traffic to a
 * password-reset form produces.
 */
export const PROBE_MAX_KEYS = 10_000;

/**
 * One fixed window per caller. A count is all the limit reads, so there is no
 * timestamp list to filter and nothing to allocate on a hit. The price is the
 * usual fixed-window one — up to twice PROBE_LIMIT across a window boundary —
 * which is fine for a counter that guards work rather than secrets.
 */
type Bucket = { count: number; windowStart: number };

/**
 * ipHash -> its current window. Kept in windowStart order: a bucket is only
 * ever inserted when its window starts, it is dropped rather than restarted
 * once that window is over, and a Map iterates in insertion order. So the front of the
 * map is always the oldest window, which is what both pruning and eviction want.
 *
 * That order only holds while `now` never goes backwards, which is why the
 * default clock is the monotonic `performance.now()` rather than `Date.now()`:
 * the wall clock can be stepped back by NTP or a resumed VM, and one bucket
 * stamped ahead of the others would then stop the pruning loop in front of
 * stale ones. Only differences are ever taken, so the clock's origin does not
 * matter. `recordProbe` still checks the caller's own bucket, so an explicit
 * `now` that is out of order cannot make it read a spent window as live.
 */
const probes = new Map<string, Bucket>();

/** Buckets examined by pruning and eviction. Test seam: the bound is the point. */
let scanned = 0;

/**
 * Record one request from `ipHash` and say whether it is allowed.
 *
 * Every call does amortised O(1) work, however many callers there are. Stale
 * buckets are dropped from the front of the map until the first live one —
 * each bucket is dropped at most once, so that is O(1) per call over a run —
 * and when the map is full the oldest bucket goes to make room. Walking the
 * whole map instead would make one request cost O(callers seen recently), and
 * behind a trusted proxy, the only configuration where this counter is
 * enforced, a prober spread over N source addresses is exactly what fills it:
 * the limiter would do O(N²) work over the run, making enumeration expensive
 * for everybody but the attacker.
 *
 * What a cap cannot do is hold a caller who rotates addresses. Every address is
 * a fresh bucket, so PROBE_LIMIT is sidestepped however the map is stored, and
 * with more than PROBE_MAX_KEYS addresses in one window a rotating caller also
 * evicts other callers' buckets, handing them a fresh budget. That is inherent
 * in keying on an address; defending against it belongs at the trusted proxy.
 * What this bounds is the amplification — one caller cannot make everybody
 * else's request more expensive.
 */
export function recordProbe(ipHash: string, now: number = performance.now()): boolean {
  for (const [key, bucket] of probes) {
    scanned++;
    if (isLive(bucket, now)) break;
    probes.delete(key);
  }

  // With a monotonic `now`, whatever survived the loop is live: a stale bucket
  // anywhere in the map would have a stale bucket, or itself, at the front. The
  // check is O(1) and keeps a spent window from outliving its time if it ever
  // does not hold; deleting before re-inserting keeps the order.
  let mine = probes.get(ipHash);
  if (mine && !isLive(mine, now)) {
    probes.delete(ipHash);
    mine = undefined;
  }
  if (!mine) {
    if (probes.size >= PROBE_MAX_KEYS) evictOldest();
    mine = { count: 0, windowStart: now };
    probes.set(ipHash, mine);
  }

  if (mine.count >= PROBE_LIMIT) return false;
  mine.count++;
  return true;
}

function isLive(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart < PROBE_WINDOW_MS;
}

function evictOldest(): void {
  const oldest = probes.keys().next();
  if (!oldest.done) {
    scanned++;
    probes.delete(oldest.value);
  }
}

/** Test seam: the counter is module state, so tests need a way to clear it. */
export function __resetProbeState(): void {
  probes.clear();
  scanned = 0;
}
__resetProbeState.size = () => probes.size;
__resetProbeState.scanned = () => scanned;
