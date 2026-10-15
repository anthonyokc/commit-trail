/**
 * Describes a hunk's location in words instead of `@@ -a,b +c,d @@`.
 * Uses the new file's line numbers. A hunk that only removes lines uses the old file's numbers.
 * Examples: "Lines 12–14", "Line 7", "Removed lines 30–31".
 */
export function describeHunk(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  const range = (start: number, count: number) => (count === 1 ? `line ${start}` : `lines ${start}–${start + count - 1}`);
  if (newCount > 0) return capitalize(range(newStart, newCount));
  if (oldCount > 0) return `Removed ${range(oldStart, oldCount)}`;
  return `Line ${newStart}`;
}

/** Describes a run of hidden unchanged lines, for example "⋯ 11 unchanged lines". */
export function describeGap(lines: number): string {
  return `⋯ ${lines} unchanged line${lines === 1 ? "" : "s"}`;
}

/**
 * Parses a unified diff hunk header line.
 * Returns `null` when the line is not a hunk header.
 */
export function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number; context: string } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    context: match[5]?.trim() ?? "",
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
