import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashReporterIp, hasTrustedProxy } from "./report-ip";

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

  it("treats TRUSTED_PROXY_HOPS=0 like no proxy", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    const shared = hashReporterIp(null);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(hashReporterIp("203.0.113.7")).toBe(shared);
  });

  it("throws on a malformed TRUSTED_PROXY_HOPS instead of silently degrading", () => {
    // A deployment that IS behind a proxy but typos the value would otherwise
    // fall into the shared bucket with zero log output — per-IP rate limiting
    // and dedup disabled invisibly. Fail closed, like the AUTH_SECRET check.
    vi.stubEnv("TRUSTED_PROXY_HOPS", "not-a-number");
    expect(() => hashReporterIp("203.0.113.7")).toThrow(/TRUSTED_PROXY_HOPS/);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "-1");
    expect(() => hashReporterIp("203.0.113.7")).toThrow(/TRUSTED_PROXY_HOPS/);
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

describe("hasTrustedProxy", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false without a declared proxy — the hash is then a shared bucket, not a client identity", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    expect(hasTrustedProxy()).toBe(false);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(hasTrustedProxy()).toBe(false);
  });

  it("is true behind a declared proxy", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(hasTrustedProxy()).toBe(true);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(hasTrustedProxy()).toBe(true);
  });

  it("throws on a malformed value, same as hashReporterIp", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "yes");
    expect(() => hasTrustedProxy()).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});
