import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  parsePatchFiles,
  processFile,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { describeHunk } from "./hunk.ts";
import type { PierreRequest } from "./pierre-worker.ts";
import { fit, span, type Line, type Span } from "./tui/styled.ts";

export const DEFAULT_PIERRE_THEME = "pierre-dark";

/** Lines that one "Show" action reveals. */
export const EXPAND_STEP = 10;

/**
 * Reveals lines in a hidden region. `down` reveals the region's first lines, continuing down from the
 * change above the region. `up` reveals its last lines, continuing up from the change below it.
 * `all` reveals the whole region.
 */
export type GapAction = "down" | "up" | "all";

/** How far each hidden region is revealed. Regions are numbered from the start of the file. */
export interface Expansion {
  /** Lines added to both ends of every hidden region. */
  all: number;
  /** Lines revealed per region, from its start (`down`) and from its end (`up`). */
  gaps: Map<number, { down: number; up: number }>;
  /** Reveal every hidden line. */
  whole: boolean;
}

export interface PierreOptions {
  /** Columns available for the diff. */
  width: number;
  /** Shiki theme name, for example "pierre-dark" or "catppuccin-mocha". */
  theme?: string;
  /** `split` shows old and new lines side by side. `auto` selects split at 120 columns or more. */
  layout?: "auto" | "unified" | "split";
  /** Omit the file name header, for panels that already name the file. */
  omitFileHeader?: boolean;
  /**
   * Complete old and new contents of the patch's file. With them, hidden regions can be revealed,
   * and the region after the last change is shown. Without them, a hidden region shows only its size.
   */
  contents?: { old: string; new: string };
  expansion?: Expansion;
}

/** A clickable action on a hidden-region row: the row, its column range, the region, and the action. */
export interface DiffAction {
  row: number;
  start: number;
  end: number;
  gap: number;
  action: GapAction;
}

/** Rendered diff lines, the rows that stand for hidden lines, and the clickable actions on those rows. */
export interface RenderedDiff {
  lines: Line[];
  gapRows: number[];
  actions: DiffAction[];
}

interface Palette {
  fg: string;
  muted: string;
  link: string;
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

/** One row of the diff before layout. Indexes point into the highlighted old and new lines. */
type Row =
  | { kind: "heading"; text: string; context: string }
  | { kind: "gap"; gap: number; hidden: number; actions: GapAction[] }
  | { kind: "context"; oldIndex: number; newIndex: number; oldNo: number; newNo: number }
  | { kind: "change"; deletions: { index: number; no: number }[]; additions: { index: number; no: number }[] };

const SPLIT_MIN_WIDTH = 120;
const NO_EXPANSION: Expansion = { all: 0, gaps: new Map(), whole: false };

/**
 * Renders a unified diff with @pierre/diffs and Shiki syntax highlighting, as styled terminal lines.
 * @pierre/diffs parses the patch and highlights each line, including word-level changes.
 * This function lays out the lines with line numbers and +/- markers, in unified or split columns.
 * An unknown file type renders as plain text. An unknown theme throws an error.
 */
export async function renderWithPierre(patch: string, options: PierreOptions): Promise<RenderedDiff> {
  const theme = options.theme ?? DEFAULT_PIERRE_THEME;
  let files = parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files);
  const full = options.contents !== undefined && files.length === 1;
  if (full) {
    const parsed = files[0]!;
    const hydrated = processFile(patch, {
      oldFile: { name: parsed.prevName ?? parsed.name, contents: options.contents!.old },
      newFile: { name: parsed.name, contents: options.contents!.new },
      isGitDiff: true,
      throwOnError: true,
    });
    if (hydrated) files = [hydrated];
  }
  const split = options.layout === "split" || ((options.layout ?? "auto") === "auto" && options.width >= SPLIT_MIN_WIDTH);
  const out: RenderedDiff = { lines: [], gapRows: [], actions: [] };

  for (const file of files) {
    const lang = getFiletypeFromFileName(file.name);
    // The Oniguruma engine highlights about twice as fast as Shiki's default JavaScript regex engine.
    const highlighter = await getSharedHighlighter({ themes: [theme], langs: [lang], preferredHighlighter: "shiki-wasm" });
    const result = renderDiffWithHighlighter(
      file,
      highlighter,
      { theme, useTokenTransformer: false, tokenizeMaxLineLength: 1000, lineDiffType: "word-alt", maxLineDiffLength: 1000 },
      { forcePlainText: false, expandedHunks: full ? true : undefined },
    );
    const palette = paletteFrom(result.themeStyles);
    const tokens: TokenSource = {
      deletion: (index) => toSpans(result.code.deletionLines[index] as HastNode | undefined, palette.fg),
      addition: (index) => toSpans(result.code.additionLines[index] as HastNode | undefined, palette.fg),
    };
    if (!options.omitFileHeader) out.lines.push(...fileHeader(file, palette, options.width));
    const rows = buildRows(file, full, options.expansion ?? NO_EXPANSION);
    const digits = String(Math.max(1, full ? file.additionLines.length : 0, ...file.hunks.map((h) => h.additionStart + h.additionCount))).length;
    layout(rows, { tokens, palette, width: options.width, digits, split }, out);
  }
  return out;
}

/**
 * Location of the worker entry point. A compiled executable stores its modules under `/$bunfs/` and resolves
 * a worker entry point from the bundle root. Running from source needs the absolute file URL.
 */
const WORKER_ENTRY = import.meta.url.includes("/$bunfs/") ? "./pierre-worker.ts" : new URL("./pierre-worker.ts", import.meta.url).href;

type WorkerReply = { id: number; result: RenderedDiff } | { id: number; error: string };

interface PendingRender {
  patch: string;
  options: PierreOptions;
  resolve: (diff: RenderedDiff) => void;
  reject: (error: unknown) => void;
}

let worker: Worker | null = null;
let workerFailed = false;
let nextRequest = 0;
/** Requests in the order they were made, including the request that the worker is rendering. */
const pending = new Map<number, PendingRender>();
let rendering: number | null = null;

/**
 * Renders like `renderWithPierre`, in a worker thread. Syntax highlighting a large file takes hundreds of
 * milliseconds, and the worker keeps that work away from the thread that reads keys and draws the screen.
 * The worker renders one request at a time and starts with the newest waiting request, which belongs to
 * the change on screen. If the worker cannot start or stops, pending and later renders run in the calling thread.
 */
export function renderWithPierreInWorker(patch: string, options: PierreOptions): Promise<RenderedDiff> {
  const thread = workerFailed ? null : pierreWorker();
  if (!thread) return renderWithPierre(patch, options);
  return new Promise((resolve, reject) => {
    pending.set(nextRequest++, { patch, options, resolve, reject });
    sendNewest(thread);
  });
}

function sendNewest(thread: Worker): void {
  if (rendering !== null || pending.size === 0) return;
  const id = [...pending.keys()].at(-1)!;
  const request = pending.get(id)!;
  rendering = id;
  thread.postMessage({ id, patch: request.patch, options: request.options } satisfies PierreRequest);
}

function pierreWorker(): Worker | null {
  if (worker) return worker;
  let thread: Worker;
  try {
    thread = new Worker(WORKER_ENTRY);
  } catch {
    workerFailed = true;
    return null;
  }
  // An idle worker must not keep the process running after the interface closes.
  thread.unref();
  thread.onmessage = (event: MessageEvent<WorkerReply>) => {
    const request = pending.get(event.data.id);
    pending.delete(event.data.id);
    rendering = null;
    if ("error" in event.data) request?.reject(new Error(event.data.error));
    else request?.resolve(event.data.result);
    sendNewest(thread);
  };
  thread.onerror = () => {
    workerFailed = true;
    thread.terminate();
    worker = null;
    rendering = null;
    for (const [id, request] of pending) {
      pending.delete(id);
      renderWithPierre(request.patch, request.options).then(request.resolve, request.reject);
    }
  };
  worker = thread;
  return thread;
}

type TokenSource = { deletion: (index: number) => Span[]; addition: (index: number) => Span[] };

function fileHeader(file: FileDiffMetadata, palette: Palette, width: number): Line[] {
  const name = file.prevName && file.prevName !== file.name ? `${file.prevName} → ${file.name}` : file.name;
  const kind = { change: "", "rename-pure": " (renamed)", "rename-changed": " (renamed)", new: " (new file)", deleted: " (deleted)" }[file.type];
  return [fit([span(`${name}${kind}`, { fg: palette.header, bold: true })], width), fit([span("─".repeat(width), { fg: palette.muted })], width)];
}

/** Returns the old and new line indexes just after a hunk's last line. */
function hunkEnd(hunk: FileDiffMetadata["hunks"][number]): { old: number; new: number } {
  let end = { old: hunk.deletionLineIndex, new: hunk.additionLineIndex };
  for (const block of hunk.hunkContent) {
    const next =
      block.type === "context"
        ? { old: block.deletionLineIndex + block.lines, new: block.additionLineIndex + block.lines }
        : { old: block.deletionLineIndex + block.deletions, new: block.additionLineIndex + block.additions };
    end = { old: Math.max(end.old, next.old), new: Math.max(end.new, next.new) };
  }
  return end;
}

/**
 * Converts a file diff to rows. A hidden region before each hunk, and after the last hunk with full
 * contents, becomes revealed context rows plus one row for the lines that stay hidden.
 * A heading names each hunk that follows hidden lines, and the first hunk.
 */
function buildRows(file: FileDiffMetadata, full: boolean, expansion: Expansion): Row[] {
  const rows: Row[] = [];
  const contextRow = (oldIndex: number, newIndex: number): Row => ({ kind: "context", oldIndex, newIndex, oldNo: oldIndex + 1, newNo: newIndex + 1 });

  /** Adds a hidden region's rows and returns how many of its lines stay hidden. */
  const addGap = (gap: number, hidden: number, oldStart: number, newStart: number, position: "first" | "middle" | "last") => {
    if (hidden <= 0) return { remaining: 0, up: 0 };
    if (!full) {
      rows.push({ kind: "gap", gap, hidden, actions: [] });
      return { remaining: hidden, up: 0 };
    }
    // The region at the file start has no change before it, so only its end can be revealed. The region at
    // the file end has no change after it, so only its start can be revealed.
    const state = expansion.gaps.get(gap) ?? { down: 0, up: 0 };
    const down = expansion.whole ? hidden : position === "first" ? 0 : Math.min(hidden, state.down + expansion.all);
    const up = expansion.whole ? 0 : position === "last" ? 0 : Math.min(hidden - down, state.up + expansion.all);
    const remaining = hidden - down - up;
    for (let k = 0; k < down; k++) rows.push(contextRow(oldStart + k, newStart + k));
    if (remaining > 0) {
      const actions: GapAction[] =
        remaining <= EXPAND_STEP ? ["all"] : [...(position !== "first" ? (["down"] as const) : []), ...(position !== "last" ? (["up"] as const) : []), "all"];
      rows.push({ kind: "gap", gap, hidden: remaining, actions });
    }
    for (let k = hidden - up; k < hidden; k++) rows.push(contextRow(oldStart + k, newStart + k));
    return { remaining, up };
  };

  let end = { old: 0, new: 0 };
  file.hunks.forEach((hunk, index) => {
    const position = index === 0 ? "first" : "middle";
    const { remaining, up } = addGap(index, hunk.collapsedBefore, end.old, end.new, position);
    if (remaining > 0 || (index === 0 && hunk.collapsedBefore === 0)) {
      // The heading covers the revealed lines above the hunk too, so it sits above them.
      const heading: Row = {
        kind: "heading",
        text: describeHunk(hunk.deletionStart - up, hunk.deletionCount + up, hunk.additionStart - up, hunk.additionCount + up),
        context: hunk.hunkContext ?? "",
      };
      rows.splice(rows.length - up, 0, heading);
    }
    let oldNo = hunk.deletionStart;
    let newNo = hunk.additionStart;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let k = 0; k < block.lines; k++) {
          rows.push({ kind: "context", oldIndex: block.deletionLineIndex + k, newIndex: block.additionLineIndex + k, oldNo: oldNo++, newNo: newNo++ });
        }
      } else {
        rows.push({
          kind: "change",
          deletions: Array.from({ length: block.deletions }, (_, k) => ({ index: block.deletionLineIndex + k, no: oldNo++ })),
          additions: Array.from({ length: block.additions }, (_, k) => ({ index: block.additionLineIndex + k, no: newNo++ })),
        });
      }
    }
    end = hunkEnd(hunk);
  });
  if (full && file.hunks.length > 0) addGap(file.hunks.length, file.additionLines.length - end.new, end.old, end.new, "last");
  return rows;
}

interface LayoutContext {
  tokens: TokenSource;
  palette: Palette;
  width: number;
  digits: number;
  split: boolean;
}

function gapLine(row: Extract<Row, { kind: "gap" }>, palette: Palette, width: number, rowIndex: number, out: RenderedDiff): Line {
  const line: Line = [span(`⋯ ${row.hidden} hidden line${row.hidden === 1 ? "" : "s"}`, { fg: palette.muted })];
  let column = line[0]!.text.length;
  for (const action of row.actions) {
    const label =
      action === "down" ? `↓ Show ${EXPAND_STEP} lines below` : action === "up" ? `↑ Show ${EXPAND_STEP} lines above` : row.actions.length === 1 ? `Show ${row.hidden} line${row.hidden === 1 ? "" : "s"}` : `Show all ${row.hidden}`;
    line.push(span("   "));
    column += 3;
    out.actions.push({ row: rowIndex, start: column, end: column + label.length, gap: row.gap, action });
    line.push(span(label, { fg: palette.link, underline: true }));
    column += label.length;
  }
  return fit(line, width);
}

function layout(rows: Row[], context: LayoutContext, out: RenderedDiff): void {
  const { tokens, palette, width, digits, split } = context;
  const num = (n: number | null) => (n === null ? " ".repeat(digits) : String(n).padStart(digits));
  const half = Math.floor((width - 1) / 2);
  const divider = span("│", { fg: palette.muted });

  const unifiedRow = (oldNo: number | null, newNo: number | null, sign: " " | "-" | "+", content: Span[], bg?: string): Line => {
    const signColor = sign === "-" ? palette.removedSign : sign === "+" ? palette.addedSign : palette.muted;
    const gutter = [span(`${num(oldNo)} ${num(newNo)} `, { fg: palette.muted, bg }), span(`${sign} `, { fg: signColor, bg })];
    return fit([...gutter, ...content.map((part) => ({ ...part, bg: part.bg ?? bg }))], width, bg ? { bg } : undefined);
  };
  const cell = (number: number, content: Span[], sign: " " | "-" | "+", bg?: string): Line => {
    const signColor = sign === "-" ? palette.removedSign : sign === "+" ? palette.addedSign : palette.muted;
    const gutter = [span(`${num(number)} `, { fg: palette.muted, bg }), span(`${sign} `, { fg: signColor, bg })];
    return fit([...gutter, ...content.map((part) => ({ ...part, bg: part.bg ?? bg }))], half, bg ? { bg } : {});
  };

  for (const row of rows) {
    if (row.kind === "heading") {
      out.lines.push(fit([span(row.text, { fg: palette.header, bold: true }), span(row.context ? ` · ${row.context}` : "", { fg: palette.muted })], width));
    } else if (row.kind === "gap") {
      out.gapRows.push(out.lines.length);
      out.lines.push(gapLine(row, palette, width, out.lines.length, out));
    } else if (row.kind === "context") {
      const oldTokens = emphasize(tokens.deletion(row.oldIndex), undefined);
      const newTokens = emphasize(tokens.addition(row.newIndex), undefined);
      out.lines.push(split ? [...cell(row.oldNo, oldTokens, " "), divider, ...cell(row.newNo, newTokens, " ")] : unifiedRow(row.oldNo, row.newNo, " ", newTokens));
    } else if (split) {
      const count = Math.max(row.deletions.length, row.additions.length);
      for (let k = 0; k < count; k++) {
        const del = row.deletions[k];
        const add = row.additions[k];
        const left = del ? cell(del.no, emphasize(tokens.deletion(del.index), palette.removedEmphasisBg), "-", palette.removedBg) : fit([], half, {});
        const right = add ? cell(add.no, emphasize(tokens.addition(add.index), palette.addedEmphasisBg), "+", palette.addedBg) : fit([], half, {});
        out.lines.push([...left, divider, ...right]);
      }
    } else {
      for (const del of row.deletions) out.lines.push(unifiedRow(del.no, null, "-", emphasize(tokens.deletion(del.index), palette.removedEmphasisBg), palette.removedBg));
      for (const add of row.additions) out.lines.push(unifiedRow(null, add.no, "+", emphasize(tokens.addition(add.index), palette.addedEmphasisBg), palette.addedBg));
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
    link: read("--diffs-modified-color") ?? "#58a6ff",
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
