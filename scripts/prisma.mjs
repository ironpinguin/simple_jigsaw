// Run a Prisma command against the active datasource provider.
//
//   DATABASE_PROVIDER = "postgresql" (default) | "sqlite"
//
// schema.prisma is the single source of truth (committed as postgresql). For a
// different provider we derive prisma/.active.prisma by swapping only the
// datasource `provider` line, and point prisma at it via --schema. This keeps
// one schema with no drift.
//
//   node scripts/prisma.mjs generate
//   node scripts/prisma.mjs db push --skip-generate

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const provider = (process.env.DATABASE_PROVIDER ?? "postgresql").toLowerCase();
const args = process.argv.slice(2);

let schemaPath = "prisma/schema.prisma";

if (provider !== "postgresql") {
  const src = readFileSync("prisma/schema.prisma", "utf8");
  const swapped = src.replace(/provider\s*=\s*"postgresql"/, `provider = "${provider}"`);
  if (swapped === src) {
    console.error("prisma.mjs: could not set datasource provider in schema.prisma");
    process.exit(1);
  }
  schemaPath = "prisma/.active.prisma";
  writeFileSync(schemaPath, swapped);
}

console.log(`prisma.mjs: provider=${provider} schema=${schemaPath}`);
execFileSync("npx", ["prisma", ...args, "--schema", schemaPath], { stdio: "inherit" });
