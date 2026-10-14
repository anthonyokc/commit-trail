import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";
import { formatNumbers, parseSelection } from "../src/selection.ts";

describe("parseSelection", () => {
  test("expands inclusive ranges in both syntaxes", () => {
    expect(parseSelection(["1:3"])).toEqual([1, 2, 3]);
    expect(parseSelection(["1-3"])).toEqual([1, 2, 3]);
  });

  test("accepts single numbers, # prefixes, and comma lists without duplicates", () => {
    expect(parseSelection(["1", "#2", "4,2", "3:4"])).toEqual([1, 2, 4, 3]);
  });

  test("rejects reversed ranges, zero, and other text", () => {
    expect(() => parseSelection(["3:1"])).toThrow("smaller than the start");
    expect(() => parseSelection(["0"])).toThrow("Numbers start at 1");
    expect(() => parseSelection(["abc"])).toThrow('Invalid pull request selection "abc"');
  });
});

test("formatNumbers compresses runs of three or more", () => {
  expect(formatNumbers([1, 2, 3, 4, 8, 10, 11])).toBe("#1–#4, #8, #10, #11");
});

describe("parseArgs", () => {
  test("report with --against keeps the focus and the comparison set apart", () => {
    const options = parseArgs(["report", "1", "--against", "1:3", "--max-diff-lines=10"]);
    expect(options.command).toBe("report");
    expect(options.numbers).toEqual([1]);
    expect(options.against).toEqual([1, 2, 3]);
    expect(options.maxDiffLines).toBe(10);
  });

  test("--against requires one focus PR", () => {
    expect(() => parseArgs(["report", "1", "2", "--against", "3"])).toThrow("exactly one focus PR");
  });

  test("--offline turns off fetching", () => {
    const options = parseArgs(["--offline", "4"]);
    expect(options.fetch).toBe(false);
    expect(options.numbers).toEqual([4]);
  });
});
