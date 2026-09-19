import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  passwordErrorKey,
  passwordField,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from "./password";

describe("passwordField", () => {
  it("states the limits once, as numbers others can quote", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });

  it("rejects anything under the minimum", () => {
    expect(passwordField.safeParse("1234567").success).toBe(false);
    expect(passwordField.safeParse("").success).toBe(false);
  });

  it("accepts the minimum and up to the maximum", () => {
    expect(passwordField.safeParse("12345678").success).toBe(true);
    expect(passwordField.safeParse("a".repeat(PASSWORD_MAX_BYTES)).success).toBe(true);
  });

  it("rejects a password past what bcrypt hashes, instead of silently truncating it", () => {
    // bcrypt ignores everything after 72 bytes, so a longer passphrase would
    // authenticate on its prefix alone with nothing saying the tail was lost.
    expect(passwordField.safeParse("a".repeat(PASSWORD_MAX_BYTES + 1)).success).toBe(false);
    expect(passwordField.safeParse("a".repeat(200)).success).toBe(false);
  });

  it("counts the maximum in bytes, because that is what bcrypt counts", () => {
    // 18 four-byte emoji are 18 characters and 72 bytes; one more is over.
    expect(passwordField.safeParse("😀".repeat(18)).success).toBe(true);
    expect(passwordField.safeParse("😀".repeat(19)).success).toBe(false);
  });

  it("rejects a non-string, so a JSON body cannot smuggle one past", () => {
    expect(passwordField.safeParse(12345678).success).toBe(false);
    expect(passwordField.safeParse(null).success).toBe(false);
  });
});

describe("passwordErrorKey", () => {
  const Schema = z.object({ password: passwordField, other: z.string() });
  const key = (input: unknown) => {
    const parsed = Schema.safeParse(input);
    return parsed.success ? null : passwordErrorKey(parsed.error.issues, "password");
  };

  it("names the minimum and the maximum apart", () => {
    expect(key({ password: "short", other: "x" })).toBe("passwordMin");
    expect(key({ password: "a".repeat(100), other: "x" })).toBe("passwordMax");
  });

  it("stays silent about a field that did not fail", () => {
    expect(key({ password: "long-enough", other: 7 })).toBe(null);
  });

  it("does not describe a missing or non-string password as too short", () => {
    // The old heuristic answered "at least 8 characters" to a body with no
    // password at all, naming a rule the caller had not broken.
    expect(key({ other: "x" })).toBe(null);
    expect(key({ password: 12345678, other: "x" })).toBe(null);
  });
});
