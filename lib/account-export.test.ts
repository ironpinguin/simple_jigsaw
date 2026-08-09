import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAccountExport } from "./account-export";

const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

const user = {
  id: "user-1",
  email: "someone@example.org",
  name: "Someone",
  role: "USER",
  emailVerified: new Date(Date.UTC(2026, 0, 2)),
  termsAcceptedAt: new Date(Date.UTC(2026, 0, 3)),
  termsVersion: "2026-01-01",
  createdAt: new Date(Date.UTC(2026, 0, 1)),
};

const puzzle = {
  id: "puzzle-1",
  title: "Urlaub",
  imageKey: "abc123.webp",
  imageWidth: 1600,
  imageHeight: 900,
  pieceCount: 100,
  cols: 10,
  rows: 10,
  seed: 42,
  isPublic: true,
  createdAt: new Date(Date.UTC(2026, 0, 4)),
};

describe("buildAccountExport", () => {
  it("reports the account's own fields", () => {
    const out = buildAccountExport({ user, puzzles: [], baseUrl: "https://jigsaw.example.org" });

    expect(out.account).toMatchObject({
      id: "user-1",
      email: "someone@example.org",
      name: "Someone",
      role: "USER",
      termsVersion: "2026-01-01",
    });
  });

  it("dates the export so the download says what it is a snapshot of", () => {
    const out = buildAccountExport({
      user,
      puzzles: [],
      baseUrl: "https://jigsaw.example.org",
      exportedAt: new Date(NOW),
    });

    expect(out.exportedAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("never carries the password hash, whatever the caller passes in", () => {
    // The one guarantee this endpoint must not lose: it hands the user a file
    // they will mail around. Asserted on the serialized payload rather than
    // the object, so a nested or renamed field cannot slip past.
    const withSecret = { ...user, passwordHash: "$2b$10$notarealhashbutstilllooksreal" };

    const json = JSON.stringify(
      buildAccountExport({
        user: withSecret,
        puzzles: [puzzle],
        baseUrl: "https://jigsaw.example.org",
      }),
    );

    expect(json).not.toContain("passwordHash");
    expect(json).not.toContain("$2b$10$");
  });

  it("lists the puzzles with their metadata", () => {
    const out = buildAccountExport({
      user,
      puzzles: [puzzle],
      baseUrl: "https://jigsaw.example.org",
    });

    expect(out.puzzles).toHaveLength(1);
    expect(out.puzzles[0]).toMatchObject({
      id: "puzzle-1",
      title: "Urlaub",
      pieceCount: 100,
      cols: 10,
      rows: 10,
      seed: 42,
      isPublic: true,
    });
  });

  it("points at each image by absolute URL instead of embedding it", () => {
    // The export is JSON, not an archive: the bytes stay where they are and
    // the file stays small enough to be a plain download.
    const out = buildAccountExport({
      user,
      puzzles: [puzzle],
      baseUrl: "https://jigsaw.example.org",
    });

    expect(out.puzzles[0].imageUrl).toBe("https://jigsaw.example.org/api/image/abc123.webp");
  });

  it("escapes an image key that would otherwise break the URL", () => {
    const out = buildAccountExport({
      user,
      puzzles: [{ ...puzzle, imageKey: "holiday photo #1.webp" }],
      baseUrl: "https://jigsaw.example.org",
    });

    expect(out.puzzles[0].imageUrl).toBe(
      "https://jigsaw.example.org/api/image/holiday%20photo%20%231.webp",
    );
  });

  it("survives an account with nothing in it", () => {
    const out = buildAccountExport({
      user: { ...user, name: null, emailVerified: null, termsAcceptedAt: null, termsVersion: null },
      puzzles: [],
      baseUrl: "https://jigsaw.example.org",
    });

    expect(out.puzzles).toEqual([]);
    expect(out.account.name).toBeNull();
    expect(out.account.emailVerified).toBeNull();
  });

  it("writes dates as ISO strings, not as engine-dependent objects", () => {
    // The file is read by other tools; Date serialization is not something to
    // leave to whatever JSON.stringify happens to do to a Prisma value.
    const out = buildAccountExport({
      user,
      puzzles: [puzzle],
      baseUrl: "https://jigsaw.example.org",
    });

    expect(out.account.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(out.puzzles[0].createdAt).toBe("2026-01-04T00:00:00.000Z");
  });
});

describe("takeExportSlot", () => {
  /**
   * The counter lives on globalThis so every webpack layer shares one budget,
   * which means the module binds it once at load and `vi.resetModules()` alone
   * does not clear it — the global has to go first. Same dance as
   * lib/retention.test.ts.
   */
  async function freshExport() {
    delete globalThis.__jigsawExportHits;
    vi.resetModules();
    return import("./account-export");
  }

  afterEach(() => {
    delete globalThis.__jigsawExportHits;
  });

  it("lets a user export up to the limit", async () => {
    const { takeExportSlot, EXPORT_RATE_LIMIT } = await freshExport();

    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) {
      expect(takeExportSlot("user-1", NOW)).toBe(true);
    }
  });

  it("turns the next one down", async () => {
    // The endpoint reads the whole account and every puzzle row, so it is the
    // most expensive thing a logged-in user can trigger by holding a key down.
    const { takeExportSlot, EXPORT_RATE_LIMIT } = await freshExport();
    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) takeExportSlot("user-1", NOW);

    expect(takeExportSlot("user-1", NOW)).toBe(false);
  });

  it("counts each user separately", async () => {
    // One noisy account must not lock everyone else out of their Art. 15 right.
    const { takeExportSlot, EXPORT_RATE_LIMIT } = await freshExport();
    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) takeExportSlot("user-1", NOW);

    expect(takeExportSlot("user-2", NOW)).toBe(true);
  });

  it("lets the user back in once the window has passed", async () => {
    const { takeExportSlot, EXPORT_RATE_LIMIT, EXPORT_RATE_WINDOW_MS } = await freshExport();
    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) takeExportSlot("user-1", NOW);

    expect(takeExportSlot("user-1", NOW + EXPORT_RATE_WINDOW_MS)).toBe(true);
  });

  it("shares one budget across module instances", async () => {
    // Otherwise each webpack layer would hand out its own full allowance.
    const first = await freshExport();
    for (let i = 0; i < first.EXPORT_RATE_LIMIT; i += 1) first.takeExportSlot("user-1", NOW);

    vi.resetModules();
    const second = await import("./account-export");

    expect(second.takeExportSlot("user-1", NOW)).toBe(false);
  });

  it("forgets hits that fall out of the window rather than growing forever", async () => {
    // A long-lived process must not accumulate one timestamp per export for
    // every user that ever asked.
    const { takeExportSlot, EXPORT_RATE_WINDOW_MS } = await freshExport();
    takeExportSlot("user-1", NOW);
    takeExportSlot("user-1", NOW + EXPORT_RATE_WINDOW_MS + 1);

    expect(globalThis.__jigsawExportHits).toEqual(
      new Map([["user-1", [NOW + EXPORT_RATE_WINDOW_MS + 1]]]),
    );
  });

  it("hands a slot back when the export never happened", async () => {
    // A request that claimed a slot and then failed bought nothing, so it must
    // not count against the hour.
    const { takeExportSlot, releaseExportSlot, EXPORT_RATE_LIMIT } = await freshExport();
    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) takeExportSlot("user-1", NOW);

    releaseExportSlot("user-1");

    expect(takeExportSlot("user-1", NOW)).toBe(true);
  });

  it("drops the entry once a user holds nothing again", async () => {
    const { takeExportSlot, releaseExportSlot } = await freshExport();
    takeExportSlot("user-1", NOW);

    releaseExportSlot("user-1");

    expect(globalThis.__jigsawExportHits).toEqual(new Map());
  });

  it("shrugs off a release from a user that holds nothing", async () => {
    const { takeExportSlot, releaseExportSlot, EXPORT_RATE_LIMIT } = await freshExport();

    releaseExportSlot("user-1");

    for (let i = 0; i < EXPORT_RATE_LIMIT; i += 1) {
      expect(takeExportSlot("user-1", NOW)).toBe(true);
    }
  });
});
