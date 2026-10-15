import { expect, test } from "bun:test";
import { renderWithPierre, type Expansion } from "../src/pierre.ts";
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
  const { lines, gapRows, actions } = await renderWithPierre(PATCH, { width: 80, layout: "unified" });
  const rows = lines.map(text).map((row) => row.trimEnd());
  expect(rows[0]).toBe("src/cache.ts");
  // The hunk starts at line 10, so 9 unchanged lines come before it.
  // Without the full file, the hidden region shows its size but has no actions.
  expect(rows[2]).toBe("⋯ 9 hidden lines");
  expect(gapRows).toEqual([2]);
  expect(actions).toEqual([]);
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

test("a hunk at the top of the file has no separator row", async () => {
  const top = PATCH.replace("@@ -10,4 +10,5 @@", "@@ -1,4 +1,5 @@");
  const { lines, gapRows } = await renderWithPierre(top, { width: 80, layout: "unified", omitFileHeader: true });
  expect(gapRows).toEqual([]);
  expect(text(lines[0]!).trimEnd()).toBe("Lines 1–5 · export function ttlFor(key: string): number {");
});

// A 60-line file with line 31 changed. With 3 context lines, the hunk covers lines 28-34.
const OLD = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
const NEW = OLD.map((line, i) => (i === 30 ? "changed 31" : line));
const FULL_PATCH = [
  "diff --git a/notes.txt b/notes.txt",
  "index 1111111..2222222 100644",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -28,7 +28,7 @@",
  ...OLD.slice(27, 30).map((line) => ` ${line}`),
  "-line 31",
  "+changed 31",
  ...OLD.slice(31, 34).map((line) => ` ${line}`),
  "",
].join("\n");
const contents = { old: OLD.join("\n") + "\n", new: NEW.join("\n") + "\n" };
const expansion = (gaps: [number, { down: number; up: number }][] = [], all = 0, whole = false): Expansion => ({ all, whole, gaps: new Map(gaps) });
const render = (e?: Expansion) => renderWithPierre(FULL_PATCH, { width: 90, layout: "unified", omitFileHeader: true, contents, expansion: e });

test("with full contents, hidden regions before and after the change offer actions toward the change", async () => {
  const { lines, gapRows, actions } = await render();
  const rows = lines.map(text).map((row) => row.trimEnd());
  // The start of the file can only grow up from the change below it. The end can only grow down from the change above it.
  expect(rows[0]).toBe("⋯ 27 hidden lines   ↑ Show 10 lines above   Show all 27");
  expect(rows[1]).toBe("Lines 28–34");
  expect(rows.at(-1)).toBe("⋯ 26 hidden lines   ↓ Show 10 lines below   Show all 26");
  expect(gapRows).toEqual([0, rows.length - 1]);
  for (const action of actions) {
    expect(text(lines[action.row]!).slice(action.start, action.end)).toMatch(/^(↓ Show 10 lines below|↑ Show 10 lines above|Show all \d+)$/);
  }
  expect(actions.map((a) => [a.gap, a.action])).toEqual([
    [0, "up"],
    [0, "all"],
    [1, "down"],
    [1, "all"],
  ]);
});

test("revealing lines above the first change moves the heading above them", async () => {
  const rows = (await render(expansion([[0, { down: 0, up: 10 }]]))).lines.map(text).map((row) => row.trimEnd());
  expect(rows[0]).toBe("⋯ 17 hidden lines   ↑ Show 10 lines above   Show all 17");
  expect(rows[1]).toBe("Lines 18–34");
  expect(rows[2]).toBe("18 18   line 18");
});

test("revealing lines below the last change continues after it", async () => {
  const rows = (await render(expansion([[1, { down: 10, up: 0 }]]))).lines.map(text).map((row) => row.trimEnd());
  const gap = rows.findIndex((row) => row.startsWith("⋯ 16 hidden lines"));
  expect(rows.slice(gap - 2, gap)).toEqual(["43 43   line 43", "44 44   line 44"]);
});

test("a region with 10 or fewer hidden lines offers one action, and whole shows every line", async () => {
  const small = (await render(expansion([[0, { down: 0, up: 20 }]]))).lines.map(text);
  expect(small[0]!.trimEnd()).toBe("⋯ 7 hidden lines   Show 7 lines");
  const whole = await render(expansion([], 0, true));
  expect(whole.gapRows).toEqual([]);
  // 59 unchanged lines, one removed, and one added. Nothing is hidden, so no heading interrupts the file.
  expect(whole.lines.length).toBe(61);
});
