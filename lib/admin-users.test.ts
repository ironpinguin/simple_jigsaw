import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { toAdminUserView } from "./admin-users";

const HASH = "$2b$10$abcdefghijklmnopqrstuv";

function row(overrides: Partial<Parameters<typeof toAdminUserView>[0]> = {}) {
  return {
    id: "user-1",
    email: "someone@example.com",
    name: "Someone",
    role: "USER",
    emailVerified: null as Date | null,
    passwordHash: null as string | null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("toAdminUserView", () => {
  it("derives hasPassword from the hash, not from anything else", () => {
    expect(toAdminUserView(row({ passwordHash: null })).hasPassword).toBe(false);
    expect(toAdminUserView(row({ passwordHash: HASH })).hasPassword).toBe(true);
  });

  it("treats the empty string as a password, because the column is nullable and nothing else", () => {
    // Deliberate: the invariant is `passwordHash === null` <=> "never redeemed".
    // An empty string is not null, so it is not an un-redeemed invitation — and
    // lib/auth.ts refuses a falsy hash at login, so such a row cannot be used
    // either way. Pinned so a future `!passwordHash` "tidy-up" has to argue with
    // a test: that spelling would report a usable-looking row as invitable and
    // hand it a password-setting link.
    expect(toAdminUserView(row({ passwordHash: "" })).hasPassword).toBe(true);
  });

  it("derives verified from emailVerified", () => {
    expect(toAdminUserView(row({ emailVerified: null })).verified).toBe(false);
    expect(toAdminUserView(row({ emailVerified: new Date() })).verified).toBe(true);
  });

  it("never carries the hash through", () => {
    const view = toAdminUserView(row({ passwordHash: HASH }));
    expect(view).not.toHaveProperty("passwordHash");
    expect(view).not.toHaveProperty("emailVerified");
    expect(JSON.stringify(view)).not.toContain(HASH);
  });

  it("passes every other column through untouched", () => {
    const view = toAdminUserView(row({ passwordHash: HASH, emailVerified: new Date() }));
    expect(view).toMatchObject({
      id: "user-1",
      email: "someone@example.com",
      name: "Someone",
      role: "USER",
    });
    expect(view.createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
  });
});

// The invariant the invite route's 409 branch rests on, asserted against the
// source rather than against behaviour — because the failure it guards is a new
// call site appearing, which no amount of exercising the current ones can catch.
//
// `app/api/admin/users/invite/route.ts` treats `passwordHash === null` as
// "invitation never redeemed" and refuses to re-invite anything else. That
// holds only while nothing sets an *existing* hash back to null. A password
// reset built the way invite already works — clear the hash, mail a
// set-password link — would make active accounts indistinguishable from
// never-activated ones, and the route would then mint a password-setting link
// for an account in use. #42 is where that could land; this is what stops it
// landing silently. See #52.
describe("the passwordHash invariant", () => {
  const ROOT = join(import.meta.dirname, "..");
  const SEARCHED = ["app", "lib", "scripts"];
  const SKIP = new Set(["node_modules", ".next", "generated"]);

  /** Every hand-written source file; generated Prisma output is not ours. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      if (SKIP.has(entry)) return [];
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!/\.(ts|tsx|mjs)$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
      return [full];
    });
  }

  const files = SEARCHED.flatMap((d) => sourceFiles(join(ROOT, d)));

  it("finds the files it is supposed to be scanning", () => {
    // A walk that silently matches nothing would make every assertion below
    // pass for the wrong reason.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith("app/api/admin/users/invite/route.ts"))).toBe(true);
  });

  it("writes passwordHash: null in exactly one place", () => {
    const writers = files
      .filter((f) => /passwordHash\s*:\s*null/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();

    // Adding a second one is not automatically wrong — but it has to be read
    // against the 409 branch and this comment before the test is updated.
    expect(writers).toEqual(["app/api/admin/users/invite/route.ts"]);
  });

  it("only ever writes that null while creating a row, never while updating one", () => {
    const src = readFileSync(join(ROOT, "app/api/admin/users/invite/route.ts"), "utf8");

    // The null belongs to a create of a brand-new, password-less row.
    expect(/prisma\.user\.create\(\{[\s\S]{0,200}?passwordHash:\s*null/.test(src)).toBe(true);

    // And no update in this route touches the column at all: clearing a hash on
    // an existing row is the shape that breaks the branch above it.
    const updates = src.match(/prisma\.user\.update\(\{[\s\S]{0,300}?\}\)/g) ?? [];
    for (const update of updates) expect(update).not.toContain("passwordHash");
  });

  it("no code path anywhere sets an existing hash back to null", () => {
    // The general form of the rule, independent of which file it lives in: any
    // prisma update whose data mentions passwordHash: null.
    const offenders = files.filter((f) =>
      /\.update\(\{[\s\S]{0,400}?passwordHash\s*:\s*null/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
