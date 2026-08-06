import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InviteSchema, RegisterSchema, signupErrorKey } from "./signup";

// The terms gate is the legal core of the signup flow: no account may be
// created without recorded consent. These tests pin the schema so a refactor
// that weakens z.literal(true) to a boolean — registration still works,
// consent silently stops being enforced — fails loudly instead.

const REGISTER = { email: "erika@example.com", password: "long-enough", termsAccepted: true };
const INVITE = { token: "tok", password: "long-enough", termsAccepted: true };

function errorKey(schema: z.ZodTypeAny, input: unknown): string | null {
  const parsed = schema.safeParse(input);
  return parsed.success ? null : signupErrorKey(parsed.error.issues);
}

describe.each([
  ["RegisterSchema", RegisterSchema, REGISTER],
  ["InviteSchema", InviteSchema, INVITE],
] as const)("%s terms gate", (_name, schema, valid) => {
  it("accepts an explicit true", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("rejects false as not accepted", () => {
    expect(errorKey(schema, { ...valid, termsAccepted: false })).toBe("termsNotAccepted");
  });

  it("rejects a missing field as not accepted", () => {
    const rest = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "termsAccepted"),
    );
    expect(errorKey(schema, rest)).toBe("termsNotAccepted");
  });

  it('rejects the string "true" as not accepted', () => {
    expect(errorKey(schema, { ...valid, termsAccepted: "true" })).toBe("termsNotAccepted");
  });
});

describe("signup error-key selection", () => {
  it("reports a short password", () => {
    expect(errorKey(RegisterSchema, { ...REGISTER, password: "short" })).toBe("passwordMin");
  });

  it("lets the password error win when the terms fail too", () => {
    expect(errorKey(RegisterSchema, { email: "erika@example.com", password: "short" })).toBe(
      "passwordMin",
    );
  });

  it("falls back to the generic key for other field errors", () => {
    expect(errorKey(RegisterSchema, { ...REGISTER, email: "not-an-email" })).toBe("invalidInput");
    expect(errorKey(InviteSchema, { ...INVITE, token: "" })).toBe("invalidInput");
  });

  it("treats a malformed body as generic invalid input, not a terms error", () => {
    expect(errorKey(RegisterSchema, null)).toBe("invalidInput");
  });
});

describe("register-only fields", () => {
  it("keeps the name optional", () => {
    // REGISTER itself carries no name, so this passing covers the omitted case.
    expect(RegisterSchema.safeParse(REGISTER).success).toBe(true);
    expect(RegisterSchema.safeParse({ ...REGISTER, name: "Erika" }).success).toBe(true);
  });
});
