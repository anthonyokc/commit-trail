import { expect, test } from "bun:test";
import { parseAnsi } from "../src/tui/ansi.ts";

test("parses combined 24-bit background and foreground codes and resets them", () => {
  // delta emits both colors in one sequence for changed lines.
  const [line] = parseAnsi("\x1b[48;2;0;40;0;38;2;248;248;242m+added\x1b[0m plain\n");
  expect(line).toEqual([
    { text: "+added", bg: "#002800", fg: "#f8f8f2" },
    { text: " plain" },
  ]);
});

test("parses basic and 256-color codes and keeps line boundaries", () => {
  expect(parseAnsi("\x1b[34mblue\x1b[39m\n\x1b[38;5;88mred\x1b[0m")).toEqual([
    [{ text: "blue", fg: "#0000ee" }],
    [{ text: "red", fg: "#870000" }],
  ]);
});

test("removes hyperlinks and other control sequences without dropping their text", () => {
  const text = "\x1b]8;;file:///a.R\x1b\\a.R\x1b]8;;\x1b\\\x1b[0K ok";
  expect(parseAnsi(text)).toEqual([[{ text: "a.R ok" }]]);
});
