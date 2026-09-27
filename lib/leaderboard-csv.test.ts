import { describe, expect, it } from "vitest";
import { leaderboardCsv, leaderboardFileName, type CsvEntry } from "./leaderboard-csv";

const H = {
  rank: "Rank",
  displayName: "Name",
  time: "Time",
  ms: "ms",
  moves: "Moves",
  achievedAt: "Achieved",
};

function entry(displayName: string, extra: Partial<CsvEntry> = {}): CsvEntry {
  return { rank: 1, displayName, ms: 83_000, moves: 40, achievedAt: "2026-09-27T12:00:00.000Z", ...extra };
}

/** The data rows as cells, without the BOM and the heading. */
function cells(csv: string): string[] {
  return csv.replace(/^\uFEFF/, "").split("\r\n")[1].split(",");
}

describe("leaderboardCsv", () => {
  it("starts with a BOM and a heading, and ends every line with CRLF", () => {
    const csv = leaderboardCsv([entry("Anna")], H);
    expect(csv.startsWith("\uFEFFRank,Name,Time,ms,Moves,Achieved\r\n")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toHaveLength(3);
  });

  it("writes the time both readable and in milliseconds", () => {
    expect(cells(leaderboardCsv([entry("Anna")], H))).toEqual([
      "1",
      "Anna",
      "1:23",
      "83000",
      "40",
      "2026-09-27T12:00:00.000Z",
    ]);
  });

  it("keeps the given order and ranks, ties included", () => {
    const csv = leaderboardCsv(
      [entry("A", { rank: 1 }), entry("B", { rank: 1 }), entry("C", { rank: 3 })],
      H,
    );
    const ranks = csv.split("\r\n").slice(1, 4).map((l) => l.split(",").slice(0, 2).join(" "));
    expect(ranks).toEqual(["1 A", "1 B", "3 C"]);
  });

  it("quotes a name with a comma or a quote", () => {
    const csv = leaderboardCsv([entry('Kim, "the" fast')], H);
    expect(csv).toContain(',"Kim, ""the"" fast",');
  });

  it.each(["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)"])(
    "defuses a name a spreadsheet would run as a formula: %s",
    (name) => {
      const line = leaderboardCsv([entry(name)], H).split("\r\n")[1];
      // The name cell, whether quoted or not, begins with the apostrophe.
      expect(line).toMatch(/^1,"?'/);
    },
  );

  it("leaves umlauts and other letters alone", () => {
    expect(cells(leaderboardCsv([entry("Jürgen Ölçek")], H))[1]).toBe("Jürgen Ölçek");
  });

  it("writes just the heading for a board without entries", () => {
    expect(leaderboardCsv([], H)).toBe("\uFEFFRank,Name,Time,ms,Moves,Achieved\r\n");
  });
});

describe("leaderboardFileName", () => {
  it("builds a plain ASCII name from the title", () => {
    expect(leaderboardFileName("Urlaub am Gardasee 2026")).toBe("leaderboard-urlaub-am-gardasee-2026.csv");
  });

  it("transliterates German letters and folds accents instead of dropping them", () => {
    expect(leaderboardFileName("Größe & Café")).toBe("leaderboard-groesse-cafe.csv");
  });

  it("cannot carry a path or a quote", () => {
    expect(leaderboardFileName('../../"evil"\r\n.csv')).toBe("leaderboard-evil-csv.csv");
  });

  it("falls back to a bare name when nothing usable is left", () => {
    expect(leaderboardFileName("🧩🧩")).toBe("leaderboard.csv");
  });

  it("caps a long title", () => {
    expect(leaderboardFileName("a".repeat(200)).length).toBeLessThanOrEqual("leaderboard-.csv".length + 60);
  });
});
