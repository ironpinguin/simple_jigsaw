import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  addressLines,
  legalOperator,
  legalInstance,
  isOperatorComplete,
  missingOperatorFields,
  legalProcessors,
} from "./legal";

/** A configuration that satisfies every requirement, to vary one field at a time. */
const COMPLETE = {
  LEGAL_NAME: "Erika Mustermann",
  LEGAL_ADDRESS: "Musterweg 1|12345 Musterstadt",
  LEGAL_EMAIL: "kontakt@example.com",
};

describe("legal address parsing", () => {
  it("splits on pipes and newlines and drops empty segments", () => {
    expect(addressLines("Musterweg 1 | 12345 Musterstadt")).toEqual([
      "Musterweg 1",
      "12345 Musterstadt",
    ]);
    expect(addressLines("A\n\nB\n")).toEqual(["A", "B"]);
  });

  it("handles CRLF line endings", () => {
    expect(addressLines("Musterweg 1\r\n12345 Musterstadt")).toEqual([
      "Musterweg 1",
      "12345 Musterstadt",
    ]);
  });

  it("treats missing and blank values as no address", () => {
    expect(addressLines(undefined)).toEqual([]);
    expect(addressLines("   |  ")).toEqual([]);
  });

  it("keeps duplicate lines rather than deduping them", () => {
    // The Impressum keys the rendered lines by index because of this.
    expect(addressLines("c/o Muster|Musterweg 1|c/o Muster")).toHaveLength(3);
  });
});

describe("legal operator", () => {
  it("reads the operator from the environment", () => {
    const operator = legalOperator({ ...COMPLETE, LEGAL_NAME: "  Erika Mustermann " });
    expect(operator.name).toBe("Erika Mustermann");
    expect(operator.addressLines).toHaveLength(2);
    expect(operator.email).toBe("kontakt@example.com");
    expect(operator.phone).toBeNull();
  });

  it("reads a phone number when one is configured", () => {
    const operator = legalOperator({ ...COMPLETE, LEGAL_PHONE: " +49 30 123456 " });
    expect(operator.phone).toBe("+49 30 123456");
  });

  it("defaults to process.env", () => {
    // The pages call legalOperator() with no argument, so the variable names in
    // this module are the contract with .env.example and both compose files.
    vi.stubEnv("LEGAL_NAME", "From Env");
    vi.stubEnv("LEGAL_ADDRESS", "Envweg 1|1000 Envstadt");
    vi.stubEnv("LEGAL_EMAIL", "env@example.com");
    try {
      const operator = legalOperator();
      expect(operator.name).toBe("From Env");
      expect(operator.addressLines).toEqual(["Envweg 1", "1000 Envstadt"]);
      expect(operator.email).toBe("env@example.com");
      expect(isOperatorComplete(operator)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("operator completeness", () => {
  it("accepts a name, a multi-line address and an email", () => {
    expect(missingOperatorFields(legalOperator(COMPLETE))).toEqual([]);
    expect(isOperatorComplete(legalOperator(COMPLETE))).toBe(true);
  });

  it("names every variable that is unset", () => {
    expect(missingOperatorFields(legalOperator({}))).toEqual([
      "LEGAL_NAME",
      "LEGAL_ADDRESS",
      "LEGAL_EMAIL",
    ]);
  });

  it("requires a name", () => {
    const operator = legalOperator({ ...COMPLETE, LEGAL_NAME: undefined });
    expect(missingOperatorFields(operator)).toEqual(["LEGAL_NAME"]);
  });

  it("does not accept whitespace as a name", () => {
    expect(missingOperatorFields(legalOperator({ ...COMPLETE, LEGAL_NAME: "   " }))).toEqual([
      "LEGAL_NAME",
    ]);
  });

  it("rejects a single-line address", () => {
    // A street without a postcode and a locality is not an address that can
    // receive post — and it is what a comma-separated or unexpanded-newline
    // value collapses to, so this gate catches those too.
    expect(missingOperatorFields(legalOperator({ ...COMPLETE, LEGAL_ADDRESS: "Weg 1" }))).toEqual([
      "LEGAL_ADDRESS",
    ]);
  });

  it("requires an electronic contact, and a phone number is not one", () => {
    // § 5 DDG asks for an email address specifically, and the GDPR rights
    // section sends data subjects there.
    const operator = legalOperator({
      ...COMPLETE,
      LEGAL_EMAIL: undefined,
      LEGAL_PHONE: "+49 30 123456",
    });
    expect(missingOperatorFields(operator)).toEqual(["LEGAL_EMAIL"]);
    expect(isOperatorComplete(operator)).toBe(false);
  });

  it("narrows name and email for a guarded caller", () => {
    const operator = legalOperator(COMPLETE);
    if (!isOperatorComplete(operator)) throw new Error("expected a complete operator");
    // Compiles only because isOperatorComplete is a type predicate.
    const name: string = operator.name;
    const email: string = operator.email;
    expect(`${name} <${email}>`).toBe("Erika Mustermann <kontakt@example.com>");
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

describe("legal instance", () => {
  it("asserts nothing when nothing is declared", () => {
    // Both statements are false for some operator, so neither may be a default.
    expect(legalInstance({})).toEqual({ hostingRegion: null, privateService: false });
  });

  it("reads the hosting region", () => {
    expect(legalInstance({ LEGAL_HOSTING_REGION: " Deutschland " }).hostingRegion).toBe(
      "Deutschland",
    );
  });

  it("treats the private-service statement as opt-in", () => {
    expect(legalInstance({ LEGAL_PRIVATE_SERVICE: "true" }).privateService).toBe(true);
    expect(legalInstance({ LEGAL_PRIVATE_SERVICE: "TRUE" }).privateService).toBe(true);
    expect(legalInstance({ LEGAL_PRIVATE_SERVICE: "false" }).privateService).toBe(false);
    expect(legalInstance({ LEGAL_PRIVATE_SERVICE: "yes" }).privateService).toBe(false);
  });
});

describe("legal pages are never prerendered", () => {
  // Deliberately a source-text assertion. The directive is the only thing
  // between a correct Impressum and one that bakes in the empty build-time
  // environment, and nothing else notices if it goes: the [locale] layout's
  // auth() call de-opts the segment today, so removing it changes no build
  // output until someone makes that layout static.
  it.each(["imprint", "privacy"])("%s declares force-dynamic", (page) => {
    const source = readFileSync(
      join(process.cwd(), "app/[locale]/legal", page, "page.tsx"),
      "utf8",
    );
    expect(source).toContain('export const dynamic = "force-dynamic"');
  });
});
