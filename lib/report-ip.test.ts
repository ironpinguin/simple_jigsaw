import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashReporterIp } from "./report-ip";

describe("hashReporterIp", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when AUTH_SECRET is unset instead of hashing with an empty key", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => hashReporterIp("203.0.113.7")).toThrow(/AUTH_SECRET/);
  });

  it("is keyed with AUTH_SECRET, so hashes are useless outside this deployment", () => {
    const here = hashReporterIp("203.0.113.7");
    vi.stubEnv("AUTH_SECRET", "another-deployment");
    expect(hashReporterIp("203.0.113.7")).not.toBe(here);
  });

  it("is deterministic for the same address", () => {
    expect(hashReporterIp("203.0.113.7")).toBe(hashReporterIp("203.0.113.7"));
  });

  it("differs between addresses", () => {
    expect(hashReporterIp("203.0.113.7")).not.toBe(hashReporterIp("203.0.113.8"));
  });

  it("returns hex that does not contain the plain address", () => {
    const hash = hashReporterIp("203.0.113.7");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203.0.113.7");
  });

  it("ignores x-forwarded-for entirely when no trusted proxy is configured", () => {
    // Default deployment (docker-compose exposes Next.js directly): the header
    // is client-forgeable, so rotating it must NOT mint fresh rate-limit
    // buckets — every value collapses into the one shared bucket.
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    expect(hashReporterIp("203.0.113.7")).toBe(hashReporterIp("6.6.6.6"));
    expect(hashReporterIp("203.0.113.7")).toBe(hashReporterIp(null));
  });

  it("treats TRUSTED_PROXY_HOPS=0 and an unparsable value like no proxy", () => {
    const unset = () => {
      vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
      return hashReporterIp(null);
    };
    const shared = unset();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(hashReporterIp("203.0.113.7")).toBe(shared);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "not-a-number");
    expect(hashReporterIp("203.0.113.7")).toBe(shared);
  });

  it("uses the last x-forwarded-for entry behind one proxy — earlier ones are client-spoofable", () => {
    expect(hashReporterIp("6.6.6.6, 203.0.113.7")).toBe(hashReporterIp("203.0.113.7"));
    expect(hashReporterIp("1.1.1.1, 2.2.2.2, 203.0.113.7")).toBe(hashReporterIp("203.0.113.7"));
    expect(hashReporterIp("6.6.6.6, 203.0.113.7")).not.toBe(hashReporterIp("6.6.6.6"));
  });

  it("uses the entry appended by the outermost trusted proxy for deeper chains", () => {
    const behindOneProxy = hashReporterIp("203.0.113.7");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    // LB -> nginx: the last entry is the LB's own address, the client is one
    // position further left.
    expect(hashReporterIp("6.6.6.6, 203.0.113.7, 10.0.0.1")).toBe(behindOneProxy);
  });

  it("falls back to the shared bucket when the chain is shorter than the configured hops", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(hashReporterIp("203.0.113.7")).toBe(hashReporterIp(null));
  });

  it("falls back to a stable bucket when the header is missing", () => {
    expect(hashReporterIp(null)).toBe(hashReporterIp(""));
  });
});
