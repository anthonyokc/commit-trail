import { expect, test } from "bun:test";
import { describeGap, describeHunk, parseHunkHeader } from "../src/hunk.ts";

test("describes a hunk with new line numbers, or old ones when it only removes lines", () => {
  expect(describeHunk(12, 2, 12, 3)).toBe("Lines 12–14");
  expect(describeHunk(7, 1, 7, 1)).toBe("Line 7");
  expect(describeHunk(30, 2, 29, 0)).toBe("Removed lines 30–31");
  expect(describeGap(1)).toBe("⋯ 1 unchanged line");
});

test("parses hunk headers, including omitted counts", () => {
  expect(parseHunkHeader("@@ -12,2 +12,3 @@ tar_option_set(")).toEqual({ oldStart: 12, oldCount: 2, newStart: 12, newCount: 3, context: "tar_option_set(" });
  expect(parseHunkHeader("@@ -5 +5 @@")).toEqual({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1, context: "" });
  expect(parseHunkHeader(" context line")).toBeNull();
});
