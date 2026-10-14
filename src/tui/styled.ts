import { StyledText, bg as withBg, bold as withBold, dim as withDim, fg as withFg, type TextChunk } from "@opentui/core";

export interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export type Line = Span[];

export const theme = {
  text: "#D8DEE9",
  muted: "#7B8494",
  accent: "#88C0D0",
  heading: "#ECEFF4",
  selectionBg: "#3B4252",
  focusBorder: "#88C0D0",
  border: "#4C566A",
  added: "#A3BE8C",
  removed: "#BF616A",
  hunk: "#B48EAD",
  warning: "#EBCB8B",
  pr: "#81A1C1",
};

export function span(text: string, style: Omit<Span, "text"> = {}): Span {
  return { text, ...style };
}

export function lineLength(line: Line): number {
  return line.reduce((total, part) => total + [...part.text].length, 0);
}

/** Cuts a line to `width` columns and, when `fill` is set, pads it with that span style. */
export function fit(line: Line, width: number, fill?: Omit<Span, "text">): Line {
  const result: Line = [];
  let used = 0;
  for (const part of line) {
    if (used >= width) break;
    const chars = [...part.text.replace(/\t/g, "  ")];
    const room = width - used;
    if (chars.length > room) {
      result.push({ ...part, text: chars.slice(0, Math.max(0, room - 1)).join("") + "…" });
      used = width;
    } else {
      result.push({ ...part, text: chars.join("") });
      used += chars.length;
    }
  }
  if (fill && used < width) result.push({ ...fill, text: " ".repeat(width - used) });
  return result;
}

export function toStyled(lines: Line[]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    for (const part of line) {
      if (part.text === "") continue;
      let chunk: TextChunk = withFg(part.fg ?? theme.text)(part.text);
      if (part.bg) chunk = withBg(part.bg)(chunk);
      if (part.bold) chunk = withBold(chunk);
      if (part.dim) chunk = withDim(chunk);
      chunks.push(chunk);
    }
    if (index < lines.length - 1) chunks.push(withFg(theme.text)("\n"));
  });
  return new StyledText(chunks);
}

/** Colors one unified diff line. */
export function diffLine(text: string): Line {
  if (text.startsWith("@@")) return [span(text, { fg: theme.hunk })];
  if (text.startsWith("+")) return [span(text, { fg: theme.added })];
  if (text.startsWith("-")) return [span(text, { fg: theme.removed })];
  if (text.startsWith("\\")) return [span(text, { fg: theme.muted })];
  return [span(text)];
}
