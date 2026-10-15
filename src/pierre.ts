import { getFiletypeFromFileName, getSharedHighlighter, parsePatchFiles, renderDiffWithHighlighter, type FileDiffMetadata } from "@pierre/diffs";
import { describeGap, describeHunk } from "./hunk.ts";
import { fit, span, type Line, type Span } from "./tui/styled.ts";

export const DEFAULT_PIERRE_THEME = "pierre-dark";

export interface PierreOptions {
  /** Columns available for the diff. */
  width: number;
  /** Shiki theme name, for example "pierre-dark" or "catppuccin-mocha". */
  theme?: string;
  /** `split` shows old and new lines side by side. `auto` selects split at 120 columns or more. */
  layout?: "auto" | "unified" | "split";
  /** Omit the file name header, for panels that already name the file. */
  omitFileHeader?: boolean;
  /** Text after the hidden-line count on separator rows, for example "e: show more". */
  expandHint?: string;
  /** Show a separator row for hidden unchanged lines before a hunk. Defaults to true. */
  showGaps?: boolean;
}

/** Rendered diff lines plus the indexes of separator rows that stand for hidden unchanged lines. */
export interface RenderedDiff {
  lines: Line[];
  gapRows: number[];
}

interface Palette {
  fg: string;
  muted: string;
  addedBg: string;
  addedEmphasisBg: string;
  addedSign: string;
  removedBg: string;
  removedEmphasisBg: string;
  removedSign: string;
  header: string;
}

/** A syntax tree node as produced by @pierre/diffs (HAST). */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SPLIT_MIN_WIDTH = 120;

/**
 * Renders a unified diff with @pierre/diffs and Shiki syntax highlighting, as styled terminal lines.
 * @pierre/diffs parses the patch and highlights each line, including word-level changes.
 * This function lays out the lines with line numbers, in unified or split columns.
 * An unknown file type renders as plain text. An unknown theme throws an error.
 */
export async function renderWithPierre(patch: string, options: PierreOptions): Promise<RenderedDiff> {
  const theme = options.theme ?? DEFAULT_PIERRE_THEME;
  const files = parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files);
  const split = options.layout === "split" || ((options.layout ?? "auto") === "auto" && options.width >= SPLIT_MIN_WIDTH);
  const out: RenderedDiff = { lines: [], gapRows: [] };

  for (const file of files) {
    const lang = getFiletypeFromFileName(file.name);
    const highlighter = await getSharedHighlighter({ themes: [theme], langs: [lang] });
    const result = renderDiffWithHighlighter(file, highlighter, {
      theme,
      useTokenTransformer: false,
      tokenizeMaxLineLength: 1000,
      lineDiffType: "word-alt",
      maxLineDiffLength: 1000,
    });
    const palette = paletteFrom(result.themeStyles);
    const tokens = {
      deletion: (index: number) => toSpans(result.code.deletionLines[index] as HastNode | undefined, palette.fg),
      addition: (index: number) => toSpans(result.code.additionLines[index] as HastNode | undefined, palette.fg),
    };
    if (!options.omitFileHeader) out.lines.push(...fileHeader(file, palette, options.width));
    (split ? layoutSplit : layoutUnified)(file, tokens, palette, options, out);
  }
  return out;
}

type TokenSource = { deletion: (index: number) => Span[]; addition: (index: number) => Span[] };

function fileHeader(file: FileDiffMetadata, palette: Palette, width: number): Line[] {
  const name = file.prevName && file.prevName !== file.name ? `${file.prevName} → ${file.name}` : file.name;
  const kind = { change: "", "rename-pure": " (renamed)", "rename-changed": " (renamed)", new: " (new file)", deleted: " (deleted)" }[file.type];
  return [fit([span(`${name}${kind}`, { fg: palette.header, bold: true })], width), fit([span("─".repeat(width), { fg: palette.muted })], width)];
}

/**
 * Adds the rows before a hunk: a separator for hidden unchanged lines, when there are any,
 * and a heading such as "Lines 12–14 · tar_option_set(".
 */
function pushHunkHeading(hunk: FileDiffMetadata["hunks"][number], palette: Palette, options: PierreOptions, out: RenderedDiff): void {
  if (hunk.collapsedBefore > 0 && options.showGaps !== false) {
    out.gapRows.push(out.lines.length);
    out.lines.push(
      fit([span(describeGap(hunk.collapsedBefore), { fg: palette.muted }), span(options.expandHint ? `   ${options.expandHint}` : "", { fg: palette.muted, dim: true })], options.width),
    );
  }
  const where = describeHunk(hunk.deletionStart, hunk.deletionCount, hunk.additionStart, hunk.additionCount);
  out.lines.push(fit([span(where, { fg: palette.header, bold: true }), span(hunk.hunkContext ? ` · ${hunk.hunkContext}` : "", { fg: palette.muted })], options.width));
}

function numberWidth(file: FileDiffMetadata): number {
  const last = Math.max(1, ...file.hunks.map((hunk) => Math.max(hunk.deletionStart + hunk.deletionCount, hunk.additionStart + hunk.additionCount)));
  return String(last).length;
}

function layoutUnified(file: FileDiffMetadata, tokens: TokenSource, palette: Palette, options: PierreOptions, out: RenderedDiff): void {
  const width = options.width;
  const digits = numberWidth(file);
  const blank = " ".repeat(digits);
  const lines = out.lines;
  const row = (oldNo: string, newNo: string, sign: string, content: Span[], bg?: string, signColor?: string): Line => {
    const gutter = [span(`${oldNo} ${newNo} `, { fg: palette.muted, bg }), span(sign, { fg: signColor ?? palette.muted, bg })];
    return fit([...gutter, ...content.map((part) => ({ ...part, bg: part.bg ?? bg }))], width, bg ? { bg } : undefined);
  };

  for (const hunk of file.hunks) {
    pushHunkHeading(hunk, palette, options, out);
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let i = 0; i < block.lines; i++) {
          lines.push(row(String(oldLine++).padStart(digits), String(newLine++).padStart(digits), "  ", emphasize(tokens.addition(block.additionLineIndex + i), undefined)));
        }
      } else {
        for (let i = 0; i < block.deletions; i++) {
          const content = emphasize(tokens.deletion(block.deletionLineIndex + i), palette.removedEmphasisBg);
          lines.push(row(String(oldLine++).padStart(digits), blank, "- ", content, palette.removedBg, palette.removedSign));
        }
        for (let i = 0; i < block.additions; i++) {
          const content = emphasize(tokens.addition(block.additionLineIndex + i), palette.addedEmphasisBg);
          lines.push(row(blank, String(newLine++).padStart(digits), "+ ", content, palette.addedBg, palette.addedSign));
        }
      }
    }
  }
}

function layoutSplit(file: FileDiffMetadata, tokens: TokenSource, palette: Palette, options: PierreOptions, out: RenderedDiff): void {
  const width = options.width;
  const digits = numberWidth(file);
  const half = Math.floor((width - 1) / 2);
  const lines = out.lines;
  const cell = (number: number, content: Span[], sign: " " | "-" | "+", bg?: string): Line => {
    const signColor = sign === "-" ? palette.removedSign : sign === "+" ? palette.addedSign : palette.muted;
    const gutter = [span(`${String(number).padStart(digits)} `, { fg: palette.muted, bg }), span(`${sign} `, { fg: signColor, bg })];
    return fit([...gutter, ...content.map((part) => ({ ...part, bg: part.bg ?? bg }))], half, bg ? { bg } : {});
  };
  const divider = span("│", { fg: palette.muted });

  for (const hunk of file.hunks) {
    pushHunkHeading(hunk, palette, options, out);
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let i = 0; i < block.lines; i++) {
          lines.push([
            ...cell(oldLine++, emphasize(tokens.deletion(block.deletionLineIndex + i), undefined), " "),
            divider,
            ...cell(newLine++, emphasize(tokens.addition(block.additionLineIndex + i), undefined), " "),
          ]);
        }
      } else {
        const rows = Math.max(block.deletions, block.additions);
        for (let i = 0; i < rows; i++) {
          const left = i < block.deletions ? cell(oldLine++, emphasize(tokens.deletion(block.deletionLineIndex + i), palette.removedEmphasisBg), "-", palette.removedBg) : fit([], half, {});
          const right = i < block.additions ? cell(newLine++, emphasize(tokens.addition(block.additionLineIndex + i), palette.addedEmphasisBg), "+", palette.addedBg) : fit([], half, {});
          lines.push([...left, divider, ...right]);
        }
      }
    }
  }
}

/** Converts one highlighted line to spans. Text inside `data-diff-span` marks a changed word. */
function toSpans(node: HastNode | undefined, fallbackFg: string): Span[] {
  const spans: Span[] = [];
  const visit = (current: HastNode, color: string, changed: boolean) => {
    if (current.type === "text") {
      const text = current.value?.replace(/[\r\n]+$/, "");
      if (text) spans.push(changed ? { text, fg: color, bg: CHANGED } : { text, fg: color });
      return;
    }
    const style = typeof current.properties?.style === "string" ? current.properties.style : "";
    const nextColor = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8})/.exec(style)?.[1] ?? color;
    const nextChanged = changed || current.properties?.["data-diff-span"] !== undefined;
    for (const child of current.children ?? []) visit(child, nextColor.slice(0, 7), nextChanged);
  };
  if (node) visit(node, fallbackFg, false);
  return spans;
}

/** Marker background that `emphasize` replaces with the line type's emphasis color. */
const CHANGED = "#__changed";

/** Replaces the changed-word marker with `emphasisBg`, or removes it when `emphasisBg` is undefined. */
function emphasize(spans: Span[], emphasisBg: string | undefined): Span[] {
  return spans.map((part) => {
    if (part.bg !== CHANGED) return part;
    const { bg: _, ...rest } = part;
    return emphasisBg ? { ...rest, bg: emphasisBg } : rest;
  });
}

/** Reads theme colors from the CSS that @pierre/diffs returns, with dark defaults for missing values. */
function paletteFrom(themeStyles: string): Palette {
  const read = (name: string) => new RegExp(`(?:^|;)\\s*${name}:\\s*(#[0-9a-fA-F]{6})`).exec(themeStyles)?.[1];
  const fg = read("color") ?? "#d8dee9";
  const bg = read("background-color") ?? "#0a0a0a";
  const added = read("--diffs-addition-color") ?? "#3fb950";
  const removed = read("--diffs-deletion-color") ?? "#f85149";
  const modified = read("--diffs-modified-color") ?? "#58a6ff";
  return {
    fg,
    muted: mix(bg, fg, 0.45),
    addedBg: mix(bg, added, 0.18),
    addedEmphasisBg: mix(bg, added, 0.4),
    addedSign: added,
    removedBg: mix(bg, removed, 0.18),
    removedEmphasisBg: mix(bg, removed, 0.4),
    removedSign: removed,
    header: modified,
  };
}

function mix(base: string, color: string, amount: number): string {
  const parse = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const [a, b] = [parse(base), parse(color)];
  return "#" + a.map((value, index) => Math.round(value + (b[index]! - value) * amount).toString(16).padStart(2, "0")).join("");
}
