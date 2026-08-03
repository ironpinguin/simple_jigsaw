import { describe, it, expect } from "vitest";
import {
  addressLines,
  legalOperator,
  isOperatorComplete,
  legalProcessors,
} from "./legal";

describe("legal address parsing", () => {
  it("splits on pipes and newlines and drops empty segments", () => {
    expect(addressLines("Musterweg 1 | 12345 Musterstadt")).toEqual([
      "Musterweg 1",
      "12345 Musterstadt",
    ]);
    expect(addressLines("A\n\nB\n")).toEqual(["A", "B"]);
  });

  it("treats missing and blank values as no address", () => {
    expect(addressLines(undefined)).toEqual([]);
    expect(addressLines("   |  ")).toEqual([]);
  });
});

describe("legal operator", () => {
  it("reads the operator from the environment", () => {
    const operator = legalOperator({
      LEGAL_NAME: "  Erika Mustermann ",
      LEGAL_ADDRESS: "Musterweg 1|12345 Musterstadt",
      LEGAL_EMAIL: "kontakt@example.com",
    });
    expect(operator.name).toBe("Erika Mustermann");
    expect(operator.addressLines).toHaveLength(2);
    expect(operator.email).toBe("kontakt@example.com");
    expect(operator.phone).toBeNull();
  });

  it("is incomplete without a name or without an address", () => {
    expect(isOperatorComplete(legalOperator({}))).toBe(false);
    expect(isOperatorComplete(legalOperator({ LEGAL_NAME: "X" }))).toBe(false);
    expect(isOperatorComplete(legalOperator({ LEGAL_ADDRESS: "Weg 1" }))).toBe(false);
  });

  it("is complete with a name and an address", () => {
    const operator = legalOperator({ LEGAL_NAME: "X", LEGAL_ADDRESS: "Weg 1|1 Ort" });
    expect(isOperatorComplete(operator)).toBe(true);
  });

  it("does not accept whitespace as a name", () => {
    expect(isOperatorComplete(legalOperator({ LEGAL_NAME: "   ", LEGAL_ADDRESS: "Weg 1" }))).toBe(
      false,
    );
  });
});

describe("legal processors", () => {
  it("reports no external processor when nothing is declared", () => {
    expect(legalProcessors({})).toEqual({ mail: null, storage: null });
  });

  it("names declared processors", () => {
    expect(
      legalProcessors({
        LEGAL_MAIL_PROCESSOR: " Example Mail GmbH ",
        LEGAL_STORAGE_PROCESSOR: "Example Storage",
      }),
    ).toEqual({ mail: "Example Mail GmbH", storage: "Example Storage" });
  });
});
