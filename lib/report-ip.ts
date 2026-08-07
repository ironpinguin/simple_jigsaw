// Reporter-IP hashing for the anonymous report endpoint. Separate from
// lib/reports.ts because node:crypto must not end up in client bundles.

import { createHmac } from "crypto";

// A malformed value must not quietly behave like "no proxy": a deployment that
// does sit behind nginx would lose per-client hashing with no sign of it.
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUSTED_PROXY_HOPS must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return hops;
}

/**
 * Whether x-forwarded-for can be trusted to identify a single client. When it
 * cannot, hashReporterIp returns one bucket shared by every visitor, so the
 * hash may only be used for collective rate limiting — never to decide that
 * two reports came from the same person (see the dedup check in
 * app/api/report/route.ts).
 */
export function hasTrustedProxy(): boolean {
  return trustedProxyHops() >= 1;
}

/**
 * HMAC of the reporter's IP so rate limiting and dedup work without ever
 * storing the plain address. x-forwarded-for is client-forgeable, so it is
 * only consulted when TRUSTED_PROXY_HOPS says how many trailing entries this
 * deployment's own reverse proxies appended: the hash uses the entry the
 * outermost trusted proxy wrote (1 → the last entry, 2 → second-to-last).
 * With the default of 0 — no trusted proxy, e.g. the shipped docker-compose
 * exposing Next.js directly — the header is ignored and every visitor shares
 * one collectively rate-limited "unknown" bucket; trusting it there would let
 * a client mint fresh rate-limit/dedup buckets by rotating the header.
 * Keyed with AUTH_SECRET so the hashes are useless outside this deployment;
 * throws when it is unset rather than silently hashing with an empty key,
 * which would make the tiny IPv4 space reversible offline.
 */
export function hashReporterIp(forwardedFor: string | null): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET must be set — reporter IP hashes would be unkeyed and reversible");
  }
  const hops = trustedProxyHops();
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const ip = hops >= 1 ? (entries[entries.length - hops] ?? "unknown") : "unknown";
  return createHmac("sha256", secret).update(ip).digest("hex");
}
