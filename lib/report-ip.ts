// Reporter-IP hashing for the anonymous report endpoint. Separate from
// lib/reports.ts because node:crypto must not end up in client bundles.

import { createHmac } from "crypto";

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
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const ip = hops >= 1 ? (entries[entries.length - hops] ?? "unknown") : "unknown";
  return createHmac("sha256", secret).update(ip).digest("hex");
}
