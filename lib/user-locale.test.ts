import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";

// The `locale` column's default is a literal in prisma/schema.prisma — Prisma
// has no way to read it from routing.ts. Every row that predates the column
// gets it, so if the two ever drift, those accounts silently start receiving
// mail in a language nobody chose. This is the only thing keeping them in step.
describe("User.locale default", () => {
  it("matches routing.defaultLocale", () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    const match = /^\s*locale\s+String\s+@default\("([^"]+)"\)/m.exec(schema);

    expect(match, "no `locale String @default(...)` line found in the schema").not.toBeNull();
    expect(match![1]).toBe(routing.defaultLocale);
  });
});
