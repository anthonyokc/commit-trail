import type { Line, Span } from "./styled.ts";

/** xterm's default colors for the 16 basic ANSI color indexes. */
const BASIC = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];

type Style = Omit<Span, "text"> & { reverse?: boolean };

/**
 * Converts text with ANSI SGR color sequences, such as delta output, to styled lines.
 * Supports basic, 256-color, and 24-bit colors plus bold, dim, italic, underline, and reverse.
 * Removes every other control sequence, including OSC hyperlinks and cursor or erase commands.
 */
export function parseAnsi(text: string): Line[] {
  const lines: Line[] = [];
  let line: Line = [];
  let style: Style = {};
  let buffer = "";

  const flush = () => {
    if (buffer === "") return;
    const { reverse, ...rest } = style;
    const part: Span = { ...rest, text: buffer };
    if (reverse) {
      part.fg = style.bg ?? "#000000";
      part.bg = style.fg ?? "#ffffff";
    }
    line.push(part);
    buffer = "";
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\x1b") {
      const next = text[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < text.length && !/[@-~]/.test(text[end]!)) end++;
        if (text[end] === "m") {
          flush();
          style = applySgr(style, text.slice(index + 2, end));
        }
        index = end;
      } else if (next === "]") {
        // OSC: ends with BEL or ESC \.
        let end = index + 2;
        while (end < text.length && text[end] !== "\x07" && !(text[end] === "\x1b" && text[end + 1] === "\\")) end++;
        index = text[end] === "\x07" ? end : end + 1;
      } else {
        index++;
      }
      continue;
    }
    if (char === "\n") {
      flush();
      lines.push(line);
      line = [];
      continue;
    }
    if (char === "\r") continue;
    buffer += char === "\t" ? "    " : char;
  }
  flush();
  if (line.length > 0) lines.push(line);
  return lines;
}

function applySgr(current: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((code) => (code === "" ? 0 : Number(code)));
  let style = { ...current };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) style = {};
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 7) style.reverse = true;
    else if (code === 22) style.bold = style.dim = false;
    else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.reverse = false;
    else if (code >= 30 && code <= 37) style.fg = BASIC[code - 30];
    else if (code >= 90 && code <= 97) style.fg = BASIC[code - 90 + 8];
    else if (code >= 40 && code <= 47) style.bg = BASIC[code - 40];
    else if (code >= 100 && code <= 107) style.bg = BASIC[code - 100 + 8];
    else if (code === 39) delete style.fg;
    else if (code === 49) delete style.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 5) {
        style[key] = color256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        style[key] = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
        i += 4;
      }
    }
  }
  return style;
}

function color256(index: number): string {
  if (index < 16) return BASIC[index]!;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return hex(level, level, level);
  }
  const cube = index - 16;
  const step = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return hex(step(Math.floor(cube / 36)), step(Math.floor(cube / 6) % 6), step(cube % 6));
}

function hex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}
