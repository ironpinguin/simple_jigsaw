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

/** Per account, per window. One person recovering one account needs very few. */
export const RESET_PER_EMAIL_LIMIT = 3;

/** Per requesting IP, per window — an office may hold several real people. */
export const RESET_PER_IP_LIMIT = 10;

export const RESET_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Every request from one IP, existing address or not. */
export const PROBE_LIMIT = 20;
export const PROBE_WINDOW_MS = 10 * 60 * 1000;

/** ipHash -> timestamps within the current window. */
const probes = new Map<string, number[]>();

/**
 * Record one request from `ipHash` and say whether it is allowed.
 *
 * Prunes as it goes: without that, every address that ever probed would be held
 * until the process restarted.
 */
export function recordProbe(ipHash: string, now: number = Date.now()): boolean {
  const cutoff = now - PROBE_WINDOW_MS;

  for (const [key, times] of probes) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) probes.delete(key);
    else probes.set(key, live);
  }

  const mine = probes.get(ipHash) ?? [];
  if (mine.length >= PROBE_LIMIT) return false;
  mine.push(now);
  probes.set(ipHash, mine);
  return true;
}

/** Test seam: the counter is module state, so tests need a way to clear it. */
export function __resetProbeState(): void {
  probes.clear();
}
__resetProbeState.size = () => probes.size;
