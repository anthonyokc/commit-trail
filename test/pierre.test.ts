import { expect, test } from "bun:test";
import { renderWithPierre } from "../src/pierre.ts";
import type { Line } from "../src/tui/styled.ts";

const PATCH = [
  "diff --git a/src/cache.ts b/src/cache.ts",
  "index 1111111..2222222 100644",
  "--- a/src/cache.ts",
  "+++ b/src/cache.ts",
  "@@ -10,4 +10,5 @@ export function ttlFor(key: string): number {",
  " const store = new Map();",
  " ",
  "-  return 60;",
  "+  return config.cacheTtl;",
  "+  // read from config",
  " }",
  "",
].join("\n");

const text = (line: Line) => line.map((part) => part.text).join("");

test("unified layout names the hunk in words, numbers lines, and tints changed lines", async () => {
  const { lines, gapRows } = await renderWithPierre(PATCH, { width: 80, layout: "unified", expandHint: "e: show more" });
  const rows = lines.map(text).map((row) => row.trimEnd());
  expect(rows[0]).toBe("src/cache.ts");
  // The hunk starts at line 10, so 9 unchanged lines come before it.
  expect(rows[2]).toBe("⋯ 9 unchanged lines   e: show more");
  expect(gapRows).toEqual([2]);
  expect(rows[3]).toBe("Lines 10–14 · export function ttlFor(key: string): number {");
  expect(rows.slice(4)).toEqual([
    "10 10   const store = new Map();",
    "11 11",
    "12    -   return 60;",
    "   12 +   return config.cacheTtl;",
    "   13 +   // read from config",
    "13 14   }",
  ]);
  const removed = lines[6]!;
  const added = lines[7]!;
  expect(removed.every((part) => part.bg !== undefined)).toBe(true);
  expect(added.every((part) => part.bg !== undefined)).toBe(true);
  expect(removed[removed.length - 1]!.bg).not.toBe(added[added.length - 1]!.bg);
  // Word-level changes get a stronger background than the rest of the line.
  expect(new Set(added.map((part) => part.bg)).size).toBeGreaterThan(1);
  // The internal marker for changed words never reaches the output.
  expect(lines.flat().some((part) => part.bg?.includes("__"))).toBe(false);
});

test("split layout pairs removed and added lines in equal-width columns", async () => {
  const { lines } = await renderWithPierre(PATCH, { width: 81, layout: "split", omitFileHeader: true });
  const rows = lines.map(text);
  expect(rows[1]!.startsWith("Lines 10–14")).toBe(true);
  for (const row of rows.slice(2)) {
    expect(row.length).toBe(81);
    expect(row[40]).toBe("│");
  }
  expect(rows[2]!.slice(0, 40).trimEnd()).toBe("10   const store = new Map();");
  expect(rows[4]!.slice(0, 40).trimEnd()).toBe("12 -   return 60;");
  expect(rows[4]!.slice(41).trimEnd()).toBe("12 +   return config.cacheTtl;");
  expect(rows[5]!.slice(0, 40).trim()).toBe("");
  expect(rows[5]!.slice(41).trimEnd()).toBe("13 +   // read from config");
});

test("auto layout switches to split at 120 columns", async () => {
  const narrow = await renderWithPierre(PATCH, { width: 119, omitFileHeader: true });
  const wide = await renderWithPierre(PATCH, { width: 120, omitFileHeader: true });
  expect(narrow.lines.map(text).some((row) => row.includes("│"))).toBe(false);
  expect(wide.lines.map(text).slice(2).every((row) => row.includes("│"))).toBe(true);
});

test("showGaps: false omits separator rows", async () => {
  const { lines, gapRows } = await renderWithPierre(PATCH, { width: 80, layout: "unified", omitFileHeader: true, showGaps: false });
  expect(gapRows).toEqual([]);
  expect(text(lines[0]!).startsWith("Lines 10–14")).toBe(true);
});

test("a hunk at the top of the file has no separator row", async () => {
  const top = PATCH.replace("@@ -10,4 +10,5 @@", "@@ -1,4 +1,5 @@");
  const { lines, gapRows } = await renderWithPierre(top, { width: 80, layout: "unified", omitFileHeader: true });
  expect(gapRows).toEqual([]);
  expect(text(lines[0]!).trimEnd()).toBe("Lines 1–5 · export function ttlFor(key: string): number {");
});
