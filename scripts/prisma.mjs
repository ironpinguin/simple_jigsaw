// Run a Prisma command for one or both datasource providers.
//
//   DATABASE_PROVIDER = "postgresql" (default) | "sqlite"
//
// schema.prisma is the single source of truth (committed as postgresql, with
// its client in lib/generated/postgresql). For SQLite we derive
// prisma/.sqlite.prisma by swapping only the datasource `provider` and the
// generator `output`, and point prisma at it via --schema. This keeps one
// schema with no drift.
//
// `generate` always builds both clients, whatever DATABASE_PROVIDER says: one
// image serves either database, and lib/db.ts picks the client at boot. Every
// other command runs against the provider DATABASE_PROVIDER names.
//
//   node scripts/prisma.mjs generate
//   node scripts/prisma.mjs db push

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// DATABASE_PROVIDER from .env, as the app gets it through Next and the Prisma
// CLI gets DATABASE_URL through prisma.config.ts: without this a host checkout
// set to sqlite in .env would push the Postgres schema at its SQLite URL.
// Variables already set win; no file is not an error.
try {
  process.loadEnvFile();
} catch {}

const PROVIDERS = ["postgresql", "sqlite"];
const SCHEMA = "prisma/schema.prisma";

function schemaFor(provider) {
  if (provider === "postgresql") return SCHEMA;

  const src = readFileSync(SCHEMA, "utf8");
  const swapped = src
    .replace(/provider\s*=\s*"postgresql"/, `provider = "${provider}"`)
    .replace(/output\s*=\s*"\.\.\/lib\/generated\/postgresql"/, `output   = "../lib/generated/${provider}"`);
  // Both substitutions have to land: a schema that kept either line would
  // generate the Postgres client a second time, over the first one.
  if (!swapped.includes(`provider = "${provider}"`) || !swapped.includes(`generated/${provider}"`)) {
    console.error(`prisma.mjs: could not derive the ${provider} schema from ${SCHEMA}`);
    process.exit(1);
  }
  const path = `prisma/.${provider}.prisma`;
  writeFileSync(path, swapped);
  return path;
}

function run(provider, args) {
  const schemaPath = schemaFor(provider);
  console.log(`prisma.mjs: provider=${provider} schema=${schemaPath}`);
  execFileSync("npx", ["prisma", ...args, "--schema", schemaPath], { stdio: "inherit" });
}

const args = process.argv.slice(2);

if (args[0] === "generate") {
  for (const provider of PROVIDERS) run(provider, args);
} else {
  const provider = (process.env.DATABASE_PROVIDER ?? "postgresql").toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    console.error(`prisma.mjs: DATABASE_PROVIDER must be one of ${PROVIDERS.join(", ")}, not "${provider}"`);
    process.exit(1);
  }
  run(provider, args);
}
