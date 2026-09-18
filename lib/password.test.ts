import { describe, it, expect } from "vitest";
import { passwordField, PASSWORD_MIN_LENGTH } from "./password";

describe("passwordField", () => {
  it("states the minimum once, as a number others can quote", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it("rejects anything under the minimum", () => {
    expect(passwordField.safeParse("1234567").success).toBe(false);
    expect(passwordField.safeParse("").success).toBe(false);
  });

  it("accepts the minimum and above", () => {
    expect(passwordField.safeParse("12345678").success).toBe(true);
    expect(passwordField.safeParse("a".repeat(200)).success).toBe(true);
  });

  it("rejects a non-string, so a JSON body cannot smuggle one past", () => {
    expect(passwordField.safeParse(12345678).success).toBe(false);
    expect(passwordField.safeParse(null).success).toBe(false);
  });
});
