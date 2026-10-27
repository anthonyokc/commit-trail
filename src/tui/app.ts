import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BoxRenderable, TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { ChangeAnalysis, ChangeAnalyzer, LineOrigin } from "../analysis.ts";
import { copyToClipboard } from "../clipboard.ts";
import type { Git } from "../git.ts";
import { changeBelongsTo, ownerLabel, type TrailModel } from "../model.ts";
import { focusReport, lineSummary, patchBody, selectionReport, changeWord } from "../report.ts";
import { formatNumbers } from "../selection.ts";
import type { FileChange, FileHistory } from "../types.ts";
import { tuicrCommandForCommit, tuicrCommandForPullRequest } from "../tuicr.ts";
import { deltaInstalled, renderWithDelta, type DeltaOptions, type DiffRenderer } from "../delta.ts";
import { describeHunk, parseHunkHeader } from "../hunk.ts";
import { EXPAND_STEP, renderWithPierre, type DiffAction, type Expansion, type GapAction, type PierreOptions, type RenderedDiff } from "../pierre.ts";
import { parseAnsi } from "./ansi.ts";
import { diffLine, fit, span, theme, toStyled, type Line } from "./styled.ts";

export interface AppOptions {
  model: TrailModel;
  git: Git;
  analyzer: ChangeAnalyzer;
  /** Directory for reports that the `r` and `R` keys write. */
  reportDir: string;
  maxDiffLines: number;
  /** Renderer for the preview and the full diff view. `t` switches it while the interface runs. */
  diffRenderer?: DiffRenderer;
  /** Unchanged lines around each change in the full diff view. Defaults to 5. */
  contextLines?: number;
  /** Unchanged lines around each change in the selected change panel. Defaults to 2. */
  previewContextLines?: number;
  /** Shiki theme for the pierre renderer. Defaults to "pierre-dark". */
  pierreTheme?: string;
  /** Renders a unified diff with @pierre/diffs. Defaults to `renderWithPierre`. */
  renderPierre?: (patch: string, options: PierreOptions) => Promise<RenderedDiff>;
  /** Renders a unified diff with delta at a width. Defaults to running the `delta` command. */
  renderDelta?: (patch: string, width: number, options: DeltaOptions) => Promise<string>;
  /** Runs an interactive command with the terminal and extra environment variables. Returns its exit status. */
  launch?: (command: string[], env?: Record<string, string>) => Promise<number>;
}

/** One node on a file's timeline: one commit, or one pull request's commits in PR mode. */
interface Entry {
  label: string;
  pr: number | null;
  changes: FileChange[];
  firstOid: string;
  lastOid: string;
  lane: number;
}

type View = "history" | "diff" | "help";
type FileRow = { kind: "dir"; text: string } | { kind: "file"; index: number };

const HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 1;

export class TrailApp {
  private readonly header: TextRenderable;
  private readonly footer: TextRenderable;
  private readonly filesBox: BoxRenderable;
  private readonly filesText: TextRenderable;
  private readonly historyBox: BoxRenderable;
  private readonly historyText: TextRenderable;
  private readonly detailBox: BoxRenderable;
  private readonly detailText: TextRenderable;

  private files: FileHistory[];
  private fileIndex = 0;
  private fileScroll = 0;
  private readonly entryIndex = new Map<string, number>();
  private prMode = false;
  private view: View = "history";
  private diffScroll = 0;
  private searching = false;
  private query = "";
  private status = "";
  private lastReport: string | null = null;
  /** In focus mode, list only files that the focus PR changes. */
  private focusOnly: boolean;
  private readonly patches = new Map<string, Promise<string>>();
  private readonly rendered = new Map<string, Promise<RenderedDiff>>();
  /** Revealed hidden lines per entry and view, keyed by `viewKey`. */
  private readonly expansions = new Map<string, Expansion>();
  private readonly contents = new Map<string, Promise<{ old: string; new: string } | undefined>>();
  /** First visible diff line in the selected change panel, and the entry it belongs to. */
  private previewScroll = 0;
  private previewKey = "";
  /**
   * Where the last drawn diff sits in the panel text: the panel row of its first visible line, the first
   * visible diff line, and its clickable actions. A mouse click maps through it to an action.
   */
  private visibleDiff: { row0: number; scroll: number; actions: DiffAction[] } | null = null;
  /** Clickable commit labels in the selected change panel: panel row, column range, and timeline index. */
  private detailTargets: { row: number; start: number; end: number; index: number }[] = [];
  private diffRenderer: DiffRenderer;
  private renderToken = 0;
  /** Time of the last change to the shown entry, from `performance.now()`. */
  private selectedAt = Number.NEGATIVE_INFINITY;
  /** Time when the last diff load finished, from `performance.now()`. */
  private loadedAt = Number.NEGATIVE_INFINITY;
  /** Deferred diff load for the latest render during rapid selection changes. */
  private loadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: AppOptions,
  ) {
    this.focusOnly = options.model.focus !== null;
    this.diffRenderer = options.diffRenderer ?? "pierre";
    this.files = this.filteredFiles();
    const root = new BoxRenderable(renderer, { id: "root", flexDirection: "column", width: "100%", height: "100%" });
    this.header = new TextRenderable(renderer, { id: "header", height: HEADER_HEIGHT, wrapMode: "none" });
    const main = new BoxRenderable(renderer, { id: "main", flexDirection: "row" });
    this.filesBox = new BoxRenderable(renderer, { id: "files", border: true, title: " FILES ", borderColor: theme.focusBorder, paddingX: 1 });
    this.filesText = new TextRenderable(renderer, { id: "files-text", wrapMode: "none" });
    this.historyBox = new BoxRenderable(renderer, { id: "history", border: true, title: " FILE HISTORY ", borderColor: theme.border, paddingX: 1 });
    this.historyText = new TextRenderable(renderer, { id: "history-text", wrapMode: "none" });
    this.detailBox = new BoxRenderable(renderer, { id: "detail", border: true, title: " SELECTED CHANGE ", borderColor: theme.border, paddingX: 1 });
    this.detailText = new TextRenderable(renderer, { id: "detail-text", wrapMode: "none" });
    this.footer = new TextRenderable(renderer, { id: "footer", height: FOOTER_HEIGHT, wrapMode: "none" });

    this.filesBox.add(this.filesText);
    this.historyBox.add(this.historyText);
    this.detailBox.add(this.detailText);
    main.add(this.filesBox);
    main.add(this.historyBox);
    root.add(this.header);
    root.add(main);
    root.add(this.detailBox);
    root.add(this.footer);
    renderer.root.add(root);

    this.detailBox.onMouseDown = (event) => this.handleDetailClick(event.x, event.y);
    this.detailBox.onMouseScroll = (event) => this.handleDetailScroll(event.scroll?.direction);
    this.filesBox.onMouseDown = (event) => this.handleFilesClick(event.y);

    renderer.on("resize", () => this.render());
    this.render();
  }

  private get width(): number {
    return this.renderer.width;
  }

  private get height(): number {
    return this.renderer.height;
  }

  /** Inner sizes of the three panels, after borders and padding. */
  private layout() {
    const body = Math.max(6, this.height - HEADER_HEIGHT - FOOTER_HEIGHT);
    const topHeight = this.view === "history" ? Math.max(5, Math.floor(body * 0.5)) : 0;
    const detailHeight = body - topHeight;
    const filesWidth = Math.max(24, Math.min(48, Math.floor(this.width * 0.32)));
    return {
      topHeight,
      detailHeight,
      filesWidth,
      historyWidth: this.width - filesWidth,
      filesInner: { width: filesWidth - 4, height: topHeight - 2 },
      historyInner: { width: this.width - filesWidth - 4, height: topHeight - 2 },
      detailInner: { width: this.width - 4, height: detailHeight - 2 },
    };
  }

  // ----- Input -----

  handleKey(key: KeyEvent): void {
    if (this.searching) return this.handleSearchKey(key);
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) return this.quit();
    if (this.view === "help") {
      this.view = "history";
      return this.render();
    }
    if (this.view === "diff") return this.handleDiffKey(key);

    this.status = "";
    const char = printable(key);
    if (char === "j" || name === "down") this.moveFile(1);
    else if (char === "k" || name === "up") this.moveFile(-1);
    else if (char === "g") this.moveFile(-this.files.length);
    else if (char === "G") this.moveFile(this.files.length);
    else if (char === "l" || name === "right") this.moveEntry(1);
    else if (char === "h" || name === "left") this.moveEntry(-1);
    else if (name === "return") {
      if (this.currentEntry()) {
        this.view = "diff";
        this.diffScroll = 0;
      }
    } else if (name === "escape") {
      if (this.query) this.applyQuery("");
    } else if (char === "p") {
      this.prMode = !this.prMode;
      this.entryIndex.clear();
      this.status = this.prMode ? "Timeline shows one node per pull request." : "Timeline shows one node per commit.";
    } else if (char === "a" && this.options.model.focus !== null) {
      this.focusOnly = !this.focusOnly;
      this.applyQuery(this.query);
      this.status = this.focusOnly ? `Showing files that PR #${this.options.model.focus} changes.` : "Showing files from every loaded PR.";
    } else if (char === "/") this.searching = true;
    else if (char === "o") void this.openTuicr(false);
    else if (char === "O") void this.openTuicr(true);
    else if (char === "r") void this.writeReport(false);
    else if (char === "R") void this.writeReport(true);
    else if (char === "y") void this.copyReport();
    else if (char === "e") return this.expand(false);
    else if (char === "E") return this.expand(true);
    else if (char === "J") this.previewScroll += 3;
    else if (char === "K") this.previewScroll = Math.max(0, this.previewScroll - 3);
    else if (char === "D") void this.openPager();
    else if (char === "?") this.view = "help";
    else return;
    this.render();
  }

  private handleSearchKey(key: KeyEvent): void {
    if (key.name === "return") {
      this.searching = false;
    } else if (key.name === "escape") {
      this.searching = false;
      this.applyQuery("");
    } else if (key.name === "backspace") {
      this.applyQuery(this.query.slice(0, -1));
    } else if (key.ctrl && key.name === "c") {
      return this.quit();
    } else if (printable(key)) {
      this.applyQuery(this.query + printable(key));
    }
    this.render();
  }

  private handleDiffKey(key: KeyEvent): void {
    const page = Math.max(1, this.layout().detailInner.height - 4);
    const name = key.name;
    const char = printable(key);
    if (name === "escape" || name === "return") this.view = "history";
    else if (char === "j" || name === "down") this.diffScroll++;
    else if (char === "k" || name === "up") this.diffScroll = Math.max(0, this.diffScroll - 1);
    else if (char === "d" || char === " " || name === "pagedown") this.diffScroll += page;
    else if (char === "u" || name === "pageup") this.diffScroll = Math.max(0, this.diffScroll - page);
    else if (char === "G") this.diffScroll = Number.MAX_SAFE_INTEGER;
    else if (char === "g") this.diffScroll = 0;
    else if (char === "l" || name === "right") {
      this.moveEntry(1);
      this.diffScroll = 0;
    } else if (char === "h" || name === "left") {
      this.moveEntry(-1);
      this.diffScroll = 0;
    } else if (char === "o") void this.openTuicr(false);
    else if (char === "O") void this.openTuicr(true);
    else if (char === "D") void this.openPager();
    else if (char === "e") this.expand(false);
    else if (char === "E") this.expand(true);
    else if (char === "t") {
      const order: DiffRenderer[] = this.deltaAvailable() ? ["pierre", "delta", "builtin"] : ["pierre", "builtin"];
      this.diffRenderer = order[(order.indexOf(this.diffRenderer) + 1) % order.length]!;
      this.diffScroll = 0;
      this.status = `Diffs use ${RENDERER_NAMES[this.diffRenderer]}.${this.deltaAvailable() ? "" : " Install delta (brew install git-delta) to add it to this list."}`;
    } else return;
    this.render();
  }

  private mode(): "full" | "preview" {
    return this.view === "diff" ? "full" : "preview";
  }

  private expansionFor(entry: Entry, mode: "full" | "preview"): Expansion {
    const key = `${mode}:${entryKey(entry)}`;
    let expansion = this.expansions.get(key);
    if (!expansion) {
      expansion = { all: 0, gaps: new Map(), whole: false };
      this.expansions.set(key, expansion);
    }
    return expansion;
  }

  /**
   * `e` reveals `EXPAND_STEP` more lines at both ends of every hidden region. `E` (`whole`) switches between
   * the whole file and the previous state. Each view of each change keeps its own expansion.
   */
  private expand(whole: boolean): void {
    const current = this.currentEntry();
    if (!current) return;
    const expansion = this.expansionFor(current.entry, this.mode());
    if (whole) {
      expansion.whole = !expansion.whole;
      this.status = expansion.whole ? "Showing the whole file. Press E to return to the changes." : "Showing the changes.";
    } else if (expansion.whole) {
      this.status = "The whole file is already shown. Press E to return to the changes.";
    } else {
      expansion.all += EXPAND_STEP;
      this.status = `Showing ${expansion.all} more lines at each end of every hidden region.`;
    }
    this.render();
  }

  /** Reveals one hidden region from one end, or completely. */
  private applyAction(entry: Entry, mode: "full" | "preview", action: DiffAction): void {
    const expansion = this.expansionFor(entry, mode);
    const state = expansion.gaps.get(action.gap) ?? { down: 0, up: 0 };
    const step: Record<GapAction, () => void> = {
      down: () => (state.down += EXPAND_STEP),
      up: () => (state.up += EXPAND_STEP),
      // The region at the file start reveals only from its end, and the region at the file end only from its start.
      all: () => {
        state.down = Number.MAX_SAFE_INTEGER;
        state.up = Number.MAX_SAFE_INTEGER;
      },
    };
    step[action.action]();
    expansion.gaps.set(action.gap, state);
    this.render();
  }

  /** Base context lines for a view: `context_lines` for the full view, `preview_context_lines` for the panel. */
  private baseContext(mode: "full" | "preview"): number {
    return mode === "full" ? (this.options.contextLines ?? 5) : (this.options.previewContextLines ?? 2);
  }

  /**
   * Context lines that Git puts in the patch. pierre reveals hidden lines from the full file contents, so it
   * uses the base context. delta and the built-in renderer cannot, so `e` and `E` add Git context lines.
   */
  private contextFor(entry: Entry, mode: "full" | "preview"): number {
    const base = this.baseContext(mode);
    if (this.diffRenderer === "pierre") return base;
    const expansion = this.expansionFor(entry, mode);
    return expansion.whole ? WHOLE_FILE : base + expansion.all;
  }

  private contextLabel(entry: Entry, mode: "full" | "preview"): string {
    const expansion = this.expansionFor(entry, mode);
    if (expansion.whole) return "whole file";
    const context = this.contextFor(entry, mode);
    const expanded = this.diffRenderer === "pierre" && (expansion.all > 0 || expansion.gaps.size > 0) ? ", expanded" : "";
    return `${context} context line${context === 1 ? "" : "s"}${expanded}`;
  }

  /** Returns the diff action under a panel position, using the last drawn diff. */
  private actionAt(row: number, column: number): DiffAction | undefined {
    if (!this.visibleDiff) return undefined;
    const index = row - this.visibleDiff.row0 + this.visibleDiff.scroll;
    return this.visibleDiff.actions.find((action) => action.row === index && column >= action.start && column < action.end);
  }

  /**
   * A click on a "Show" action reveals hidden lines, in either view.
   * In the change panel, a click on a commit label selects that change, and a click elsewhere opens the diff view.
   */
  private handleDetailClick(screenX: number, screenY: number): void {
    const current = this.currentEntry();
    if (!current || this.view === "help") return;
    const row = screenY - this.detailText.screenY;
    const column = screenX - this.detailText.screenX;
    const action = this.actionAt(row, column);
    if (action) return this.applyAction(current.entry, this.mode(), action);
    if (this.view === "diff") return;
    const target = this.detailTargets.find((t) => t.row === row && column >= t.start && column < t.end);
    if (target) {
      this.entryIndex.set(current.file.path, target.index);
      return this.render();
    }
    this.view = "diff";
    this.diffScroll = 0;
    this.render();
  }

  private handleDetailScroll(direction: string | undefined): void {
    const delta = direction === "down" ? 3 : direction === "up" ? -3 : 0;
    if (delta === 0) return;
    if (this.view === "diff") this.diffScroll = Math.max(0, this.diffScroll + delta);
    else if (this.view === "history") this.previewScroll = Math.max(0, this.previewScroll + delta);
    else return;
    this.render();
  }

  private handleFilesClick(screenY: number): void {
    if (this.view !== "history") return;
    const row = this.fileRows()[screenY - this.filesText.screenY + this.fileScroll];
    if (row?.kind !== "file") return;
    this.fileIndex = row.index;
    this.render();
  }

  private filteredFiles(): FileHistory[] {
    const needle = this.query.toLowerCase();
    const focus = this.options.model.focus;
    return this.options.model.histories.filter(
      (history) =>
        (!this.focusOnly || focus === null || history.changes.some((change) => changeBelongsTo(change, focus))) &&
        history.paths.some((path) => path.toLowerCase().includes(needle)),
    );
  }

  private applyQuery(query: string): void {
    const current = this.files[this.fileIndex];
    this.query = query;
    this.files = this.filteredFiles();
    const kept = current ? this.files.indexOf(current) : -1;
    this.fileIndex = kept >= 0 ? kept : 0;
    this.fileScroll = 0;
  }

  private moveFile(delta: number): void {
    if (this.files.length === 0) return;
    this.fileIndex = Math.max(0, Math.min(this.files.length - 1, this.fileIndex + delta));
  }

  private moveEntry(delta: number): void {
    const file = this.files[this.fileIndex];
    if (!file) return;
    const entries = this.entries(file);
    const next = Math.max(0, Math.min(entries.length - 1, this.selectedEntryIndex(file, entries) + delta));
    this.entryIndex.set(file.path, next);
  }

  private quit(): void {
    this.renderer.destroy();
  }

  // ----- Data -----

  private entries(file: FileHistory): Entry[] {
    const groups: Entry[] = [];
    for (const change of file.changes) {
      const label = ownerLabel(change);
      const existing = this.prMode ? groups.find((entry) => entry.label === label) : undefined;
      if (existing) {
        existing.changes.push(change);
        existing.lastOid = change.oid;
      } else {
        groups.push({ label, pr: change.pr, changes: [change], firstOid: change.oid, lastOid: change.oid, lane: 0 });
      }
    }
    if (this.prMode) groups.sort((a, b) => this.options.model.ancestry.order(a.lastOid) - this.options.model.ancestry.order(b.lastOid));

    // Assign lanes greedily: an entry continues the first lane whose last entry is its ancestor.
    const laneEnds: Entry[] = [];
    for (const entry of groups) {
      const lane = laneEnds.findIndex((end) => this.options.model.ancestry.isAncestor(end.lastOid, entry.firstOid));
      if (lane >= 0) {
        entry.lane = lane;
        laneEnds[lane] = entry;
      } else {
        entry.lane = laneEnds.length;
        laneEnds.push(entry);
      }
    }
    return groups;
  }

  private selectedEntryIndex(file: FileHistory, entries: Entry[]): number {
    const stored = this.entryIndex.get(file.path);
    if (stored !== undefined) return Math.min(stored, entries.length - 1);
    const focus = this.options.model.focus;
    const own = focus === null ? -1 : entries.findIndex((entry) => entry.pr === focus);
    return own >= 0 ? own : 0;
  }

  private currentEntry(): { file: FileHistory; entries: Entry[]; index: number; entry: Entry } | null {
    const file = this.files[this.fileIndex];
    if (!file) return null;
    const entries = this.entries(file);
    const index = this.selectedEntryIndex(file, entries);
    const entry = entries[index];
    return entry ? { file, entries, index, entry } : null;
  }

  private relation(selected: Entry, other: Entry): "earlier" | "later" | "parallel" {
    const ancestry = this.options.model.ancestry;
    if (ancestry.isAncestor(other.lastOid, selected.firstOid)) return "earlier";
    if (ancestry.isAncestor(selected.lastOid, other.firstOid)) return "later";
    return "parallel";
  }

  private async analyses(entry: Entry): Promise<ChangeAnalysis[]> {
    return Promise.all(entry.changes.map((change) => this.options.analyzer.analyze(change)));
  }

  private entryPaths(entry: Entry): string[] {
    return [...new Set(entry.changes.flatMap((change) => (change.oldPath ? [change.oldPath, change.path] : [change.path])))];
  }

  /**
   * Returns an entry's complete patch with `contextLines` unchanged lines around each change.
   * PR mode diffs from before the first commit to after the last commit.
   */
  private patchText(entry: Entry, contextLines = 3): Promise<string> {
    if (entry.changes.length === 1 && contextLines === 3) return this.options.analyzer.analyze(entry.changes[0]!).then((a) => a.patch.text);
    const key = `${entryKey(entry)}:U${contextLines}`;
    let cached = this.patches.get(key);
    if (!cached) {
      const paths = this.entryPaths(entry);
      const parent = this.options.model.commits.get(entry.firstOid)?.parents[0] ?? null;
      cached = (
        entry.changes.length === 1
          ? this.options.git.commitPatch(entry.lastOid, paths, contextLines)
          : this.options.git.rangePatch(parent, entry.lastOid, paths, contextLines)
      ).then((patch) => patch.text);
      this.patches.set(key, cached);
    }
    return cached;
  }

  private deltaAvailable(): boolean {
    return this.options.renderDelta !== undefined || deltaInstalled();
  }

  /**
   * Returns the styled diff for the full diff view (`full`) or the selected change panel (`preview`).
   * Git supplies `contextLines` (or `previewContextLines`) unchanged lines around each change, plus any expansion.
   * The preview omits the file header that the panel already shows.
   * If delta or pierre fails, the view falls back to the built-in renderer and the footer shows the error.
   */
  private async styledDiff(entry: Entry, width: number, mode: "full" | "preview"): Promise<RenderedDiff> {
    const preview = mode === "preview";
    const context = this.contextFor(entry, mode);
    const renderer = this.diffRenderer;
    const expansion = this.expansionFor(entry, mode);
    if (renderer !== "builtin") {
      const state = renderer === "pierre" ? JSON.stringify([expansion.all, expansion.whole, [...expansion.gaps]]) : "";
      const key = `${renderer}:${entryKey(entry)}:${width}:${mode}:U${context}:${state}`;
      let cached = this.rendered.get(key);
      if (!cached) {
        cached = this.patchText(entry, context).then(async (patch): Promise<RenderedDiff> => {
          if (patch.trim() === "") return { lines: [], gapRows: [], actions: [] };
          if (renderer === "pierre") {
            const render = this.options.renderPierre ?? renderWithPierre;
            const contents = await this.fileContents(entry);
            return render(patch, { width, theme: this.options.pierreTheme, omitFileHeader: preview, contents, expansion });
          }
          const render = this.options.renderDelta ?? ((p: string, w: number, o: DeltaOptions) => renderWithDelta(p, w, this.options.git.root, o));
          const text = await render(patch, width, { omitFileHeader: preview });
          return { lines: trimBlankStart(parseAnsi(text)), gapRows: [], actions: [] };
        });
        this.rendered.set(key, cached);
      }
      try {
        return await cached;
      } catch (error) {
        this.rendered.delete(key);
        this.diffRenderer = "builtin";
        this.status = `${renderer} failed, so the built-in diff is shown: ${error instanceof Error ? error.message : String(error)}`;
        this.footer.content = toStyled([fit(this.footerLine(), this.width)]);
      }
    }
    const body = patchBody(await this.patchText(entry, context));
    return { lines: body.map(builtinDiffLine), gapRows: [], actions: [] };
  }

  /**
   * Returns the complete file before and after an entry, for revealing hidden lines.
   * An added file has empty old contents, and a deleted file has empty new contents.
   * Returns `undefined` when Git cannot read either version.
   */
  private fileContents(entry: Entry): Promise<{ old: string; new: string } | undefined> {
    const key = entryKey(entry);
    let cached = this.contents.get(key);
    if (!cached) {
      const first = entry.changes[0]!;
      const last = entry.changes[entry.changes.length - 1]!;
      const parent = this.options.model.commits.get(entry.firstOid)?.parents[0];
      const read = async () => {
        const old = first.status === "A" || !parent ? "" : await this.options.git.fileAt(parent, first.oldPath ?? first.path);
        const next = last.status === "D" ? "" : await this.options.git.fileAt(entry.lastOid, last.path);
        return old === null || next === null ? undefined : { old, new: next };
      };
      cached = read();
      this.contents.set(key, cached);
    }
    return cached;
  }

  // ----- Rendering -----

  render(): void {
    const token = ++this.renderToken;
    clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    const layout = this.layout();
    this.filesBox.visible = this.view === "history";
    this.historyBox.visible = this.view === "history";
    this.filesBox.width = layout.filesWidth;
    this.filesBox.height = layout.topHeight;
    this.historyBox.width = layout.historyWidth;
    this.historyBox.height = layout.topHeight;
    this.detailBox.height = layout.detailHeight;
    this.detailBox.width = this.width;

    this.header.content = toStyled(this.headerLines());
    this.footer.content = toStyled([fit(this.footerLine(), this.width)]);

    if (this.view === "help") {
      this.detailBox.title = " HELP ";
      this.detailText.content = toStyled(this.helpLines().map((line) => fit(line, layout.detailInner.width)));
      return;
    }

    this.filesText.content = toStyled(this.fileLines(layout.filesInner.width, layout.filesInner.height));
    const current = this.currentEntry();
    if (!current) {
      this.historyText.content = toStyled([[span(this.query ? "No file matches the search." : "The selected pull requests change no files.", { fg: theme.muted })]]);
      this.detailText.content = toStyled([]);
      return;
    }
    this.historyText.content = toStyled(this.historyLines(current, layout.historyInner.width, layout.historyInner.height));
    const shownKey = `${current.file.path}:${entryKey(current.entry)}`;
    let rapid = false;
    if (shownKey !== this.previewKey) {
      this.previewKey = shownKey;
      this.previewScroll = 0;
      // Keys that arrive while a diff loads can reach the app only after the load finishes. A selection change
      // soon after the last selection change or load counts as rapid.
      const now = performance.now();
      rapid = now - Math.max(this.selectedAt, this.loadedAt) < RAPID_SELECTION_MS;
      this.selectedAt = now;
    }
    this.visibleDiff = null;

    let show: () => Promise<void>;
    if (this.view === "diff") {
      this.detailBox.title = ` DIFF ${current.entry.label} ${current.file.path} `;
      this.detailText.content = toStyled([[span("Loading diff…", { fg: theme.muted })]]);
      show = () =>
        this.styledDiff(current.entry, layout.detailInner.width, "full").then((diff) => {
          if (token !== this.renderToken) return;
          this.detailText.content = toStyled(this.diffLines(current.entry, diff, layout.detailInner.width, layout.detailInner.height));
        });
    } else {
      this.detailBox.title = " SELECTED CHANGE ";
      this.detailText.content = toStyled(this.detailLines(current, null, null, layout.detailInner.width, layout.detailInner.height));
      show = () =>
        Promise.all([this.analyses(current.entry), this.styledDiff(current.entry, layout.detailInner.width, "preview")]).then(([analyses, preview]) => {
          if (token !== this.renderToken) return;
          this.detailText.content = toStyled(this.detailLines(current, analyses, preview, layout.detailInner.width, layout.detailInner.height));
        });
    }
    const load = () => void show().finally(() => (this.loadedAt = performance.now()));
    // During rapid selection changes, for example a held arrow key, only the change that stays selected for
    // SETTLE_MS loads. Changes that are passed over start no Git commands and no syntax highlighting.
    if (!rapid) return load();
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      if (token === this.renderToken && !this.renderer.isDestroyed) load();
    }, SETTLE_MS);
  }

  private headerLines(): Line[] {
    const model = this.options.model;
    const repo = `${model.repository.owner}/${model.repository.name}`;
    const notes = model.skipped.length + model.stale.length + model.warnings.length;
    const first: Line = [
      span(" commit-trail ", { fg: theme.heading, bold: true }),
      span(` ${repo}`, { fg: theme.accent }),
      span(`  Branch: ${model.branch ?? "(detached)"}`, { fg: theme.muted }),
    ];
    const second: Line = [
      span(` PRs: ${formatNumbers(model.selected) || "none"}`, { fg: theme.text }),
      span(`  ${this.files.length} file${this.files.length === 1 ? "" : "s"}`, { fg: theme.muted }),
      span(`  Timeline: ${this.prMode ? "pull requests" : "commits"}`, { fg: theme.muted }),
    ];
    if (model.focus !== null) {
      second.push(span(`  Focus: #${model.focus}`, { fg: theme.pr }));
      second.push(span(this.focusOnly ? "  Files: focus PR (a: all)" : "  Files: all PRs (a: focus PR)", { fg: theme.muted }));
    }
    if (notes > 0) second.push(span(`  ${notes} note${notes === 1 ? "" : "s"} (press ?)`, { fg: theme.warning }));
    return [fit(first, this.width), fit(second, this.width)];
  }

  private footerLine(): Line {
    if (this.searching) return [span(" Search: ", { fg: theme.accent }), span(this.query + "▏"), span("   Enter keep  Esc clear", { fg: theme.muted })];
    if (this.status) return [span(` ${this.status}`, { fg: theme.warning })];
    if (this.view === "diff") return [span(" j/k Scroll  d/u Page  h/l Change  e/E Expand  t Renderer  D Pager  o tuicr PR  O tuicr commit  Esc Back  q Quit", { fg: theme.muted })];
    const hints = " j/k Files  h/l Timeline  Enter Diff  J/K Preview  e/E Expand  p PR/commit  o tuicr  / Search  r Report  y Copy  ? Help  q Quit";
    return [span(hints + (this.query ? `   [filter: ${this.query}]` : ""), { fg: theme.muted })];
  }

  private fileRows(): FileRow[] {
    const rows: FileRow[] = [];
    let lastDir: string | null = null;
    this.files.forEach((file, index) => {
      const slash = file.path.lastIndexOf("/");
      const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
      if (dir !== lastDir) {
        if (dir) rows.push({ kind: "dir", text: dir });
        lastDir = dir;
      }
      rows.push({ kind: "file", index });
    });
    return rows;
  }

  private fileLines(width: number, height: number): Line[] {
    if (this.files.length === 0) return [[span(this.query ? "No matches." : "No files.", { fg: theme.muted })]];
    const rows = this.fileRows();
    const selectedRow = rows.findIndex((row) => row.kind === "file" && row.index === this.fileIndex);
    if (selectedRow < this.fileScroll) this.fileScroll = Math.max(0, selectedRow - 1);
    if (selectedRow >= this.fileScroll + height) this.fileScroll = selectedRow - height + 1;
    const focus = this.options.model.focus;
    return rows.slice(this.fileScroll, this.fileScroll + height).map((row) => {
      if (row.kind === "dir") return fit([span(row.text, { fg: theme.muted })], width);
      const file = this.files[row.index]!;
      const selected = row.index === this.fileIndex;
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const owners = new Set(file.changes.map(ownerLabel));
      const touchesFocus = focus !== null && file.changes.some((change) => change.pr === focus);
      const count = String(file.changes.length);
      const style = selected ? { bg: theme.selectionBg } : {};
      const nameWidth = Math.max(4, width - count.length - 4);
      const line: Line = [
        span(selected ? "› " : "  ", { ...style, fg: theme.accent }),
        ...fit([span(name, { ...style, fg: touchesFocus ? theme.heading : theme.text, bold: selected })], nameWidth, style),
        span(" ", style),
        span(count, { ...style, fg: owners.size > 1 ? theme.warning : theme.muted }),
      ];
      return fit(line, width, style);
    });
  }

  private historyLines(current: NonNullable<ReturnType<TrailApp["currentEntry"]>>, width: number, height: number): Line[] {
    const { file, entries, index } = current;
    const lines: Line[] = [];
    const prs = new Set(entries.map((entry) => entry.label));
    lines.push(fit([span(file.path, { fg: theme.heading, bold: true }), span(`  ${file.changes.length} change${file.changes.length === 1 ? "" : "s"} in ${prs.size} PR${prs.size === 1 ? "" : "s"}`, { fg: theme.muted })], width));
    if (file.paths.length > 1) lines.push(fit([span(`Also named: ${file.paths.filter((p) => p !== file.path).join(", ")}`, { fg: theme.muted })], width));
    lines.push([]);

    // Horizontal timeline: one row per lane. Columns follow topological order across all lanes.
    const cell = Math.max(7, ...entries.map((entry) => entry.label.length + 4));
    const visible = Math.max(1, Math.floor((width - 4) / cell));
    const start = Math.max(0, Math.min(index - Math.floor(visible / 2), entries.length - visible));
    const shown = entries.slice(start, start + visible);
    const laneCount = Math.max(...entries.map((entry) => entry.lane)) + 1;
    const laneBudget = Math.max(1, Math.floor(height / 3));
    const selectedLane = entries[index]!.lane;
    const lanes = [...Array(laneCount).keys()].sort((a, b) => Number(b === selectedLane) - Number(a === selectedLane) || a - b).slice(0, laneBudget).sort((a, b) => a - b);
    for (const lane of lanes) {
      const laneEntries = entries.filter((entry) => entry.lane === lane);
      const firstPos = entries.indexOf(laneEntries[0]!);
      const lastPos = entries.indexOf(laneEntries[laneEntries.length - 1]!);
      const row: Line = [span(start > 0 ? "◀ " : "  ", { fg: theme.muted })];
      shown.forEach((entry, offset) => {
        const position = start + offset;
        const continues = position >= firstPos && position < lastPos;
        if (entry.lane === lane) {
          const isSelected = position === index;
          const label = ` ${entry.label} `;
          row.push(
            span(isSelected ? "◉" : "●", { fg: isSelected ? theme.accent : theme.text, bold: isSelected }),
            span(label, { fg: isSelected ? theme.accent : theme.pr, bold: isSelected }),
            span((continues ? "─" : " ").repeat(cell - 1 - label.length), { fg: theme.border }),
          );
        } else {
          row.push(span((continues ? "─" : " ").repeat(cell), { fg: theme.border }));
        }
      });
      if (start + visible < entries.length) row.push(span(" ▶", { fg: theme.muted }));
      lines.push(fit(row, width));
    }
    if (laneCount > lanes.length) lines.push(fit([span(`${laneCount - lanes.length} more lanes are not shown. The list below includes every change.`, { fg: theme.muted })], width));
    if (laneCount > 1) lines.push(fit([span(`Separate lanes are separate branches. Git defines no order between them.`, { fg: theme.muted })], width));
    lines.push([]);

    // Vertical list of the same entries.
    const listHeight = Math.max(1, height - lines.length);
    const listStart = Math.max(0, Math.min(index - Math.floor(listHeight / 2), entries.length - listHeight));
    entries.slice(listStart, listStart + listHeight).forEach((entry, offset) => {
      const position = listStart + offset;
      const selected = position === index;
      const style = selected ? { bg: theme.selectionBg } : {};
      const first = entry.changes[0]!;
      const info = this.options.model.commits.get(entry.lastOid);
      const additions = entry.changes.reduce((sum, change) => sum + change.additions, 0);
      const deletions = entry.changes.reduce((sum, change) => sum + change.deletions, 0);
      const what = this.prMode ? `${entry.changes.length} commit${entry.changes.length === 1 ? "" : "s"}` : changeWord(first);
      lines.push(
        fit(
          [
            span(selected ? "› " : "  ", { ...style, fg: theme.accent }),
            span(`${String(position + 1).padStart(2)}  `, { ...style, fg: theme.muted }),
            span(entry.label.padEnd(6), { ...style, fg: theme.pr, bold: selected }),
            span(`${entry.lastOid.slice(0, 7)}  `, { ...style, fg: theme.muted }),
            span(what.padEnd(10), style),
            span(`+${additions}`, { ...style, fg: theme.added }),
            span(` -${deletions}  `, { ...style, fg: theme.removed }),
            span(this.prMode ? (this.options.model.prs.get(entry.pr ?? -1)?.title ?? "") : (info?.subject ?? ""), style),
          ],
          width,
          style,
        ),
      );
    });
    return lines.slice(0, height);
  }

  private detailLines(
    current: NonNullable<ReturnType<TrailApp["currentEntry"]>>,
    analyses: ChangeAnalysis[] | null,
    preview: RenderedDiff | null,
    width: number,
    height: number,
  ): Line[] {
    const { entries, entry } = current;
    const model = this.options.model;
    const lines: Line[] = [];
    const pr = entry.pr !== null ? model.prs.get(entry.pr) : undefined;
    const prState = pr ? (pr.isDraft ? "draft" : pr.state.toLowerCase()) : "";
    lines.push([
      span(entry.pr !== null ? `PR #${entry.pr}: ` : `PR ${entry.label} (ambiguous): `, { fg: theme.pr, bold: true }),
      span(pr?.title ?? "", { fg: theme.heading, bold: true }),
      span(pr ? `  ${prState}  @${pr.author}` : "", { fg: theme.muted }),
    ]);
    for (const change of entry.changes.slice(-3)) {
      const info = model.commits.get(change.oid);
      lines.push([
        span("Commit: ", { fg: theme.muted }),
        span(change.oid.slice(0, 7), { fg: theme.accent }),
        span(`  ${info?.subject ?? ""}`),
        span(`  ${info?.authorDate.slice(0, 10) ?? ""}`, { fg: theme.muted }),
      ]);
    }
    if (entry.changes.length > 3) lines.push([span(`… and ${entry.changes.length - 3} earlier commits`, { fg: theme.muted })]);
    const last = entry.changes[entry.changes.length - 1]!;
    lines.push([
      span("File: ", { fg: theme.muted }),
      span(last.path),
      span(`  ${this.prMode ? `${entry.changes.length} commit(s)` : changeWord(last)}${last.status === "R" && last.oldPath ? ` from ${last.oldPath}` : ""}, ${entry.changes.map(lineSummary).join(", ")}`, {
        fg: theme.muted,
      }),
    ]);

    if (analyses === null) {
      lines.push([span("Reading diff and blame…", { fg: theme.muted })]);
    } else {
      const contexts = [...new Set(analyses.flatMap((analysis) => analysis.contexts))];
      if (contexts.length > 0) lines.push([span("Hunk context: ", { fg: theme.muted }), span(contexts.join(" | "))]);
      const revises = mergeOrigins(analyses.flatMap((analysis) => analysis.origins)).filter((origin) => origin.pr !== entry.pr);
      if (revises.length > 0) {
        lines.push([
          span("Revises: ", { fg: theme.warning }),
          span(
            revises
              .map((origin) => `${origin.replaced > 0 ? `replaces ${origin.replaced}` : `edits next to ${origin.adjacent}`} line(s) from ${origin.pr === null ? "?" : `#${origin.pr}`} ${origin.oid.slice(0, 7)}`)
              .join("; "),
          ),
        ]);
      }
    }

    const groups = { earlier: [] as Entry[], later: [] as Entry[], parallel: [] as Entry[] };
    for (const other of entries) if (other !== entry) groups[this.relation(entry, other)].push(other);
    // Each listed change is a click target that selects it on the timeline.
    const targets: { row: number; start: number; end: number; index: number }[] = [];
    const relationLine = (title: string, list: Entry[], color: string, suffix = ""): Line => {
      const line: Line = [span(title, { fg: theme.muted })];
      if (list.length === 0) return [...line, span("None")];
      let column = title.length;
      list.forEach((other, position) => {
        if (position > 0) {
          line.push(span(", "));
          column += 2;
        }
        const text = `${other.label} ${other.lastOid.slice(0, 7)}`;
        targets.push({ row: lines.length, start: column, end: column + text.length, index: entries.indexOf(other) });
        line.push(span(text, { fg: color, underline: true }));
        column += text.length;
      });
      return suffix ? [...line, span(suffix, { fg: theme.muted })] : line;
    };
    lines.push(relationLine("Earlier changes: ", groups.earlier, theme.accent));
    lines.push(relationLine("Later changes:   ", groups.later, theme.warning));
    if (groups.parallel.length > 0) lines.push(relationLine("Parallel:        ", groups.parallel, theme.accent, " (no defined order)"));
    this.detailTargets = targets;

    const attribution = model.attributions.get(last.oid);
    if (attribution && attribution.equivalents.length > 0) {
      lines.push([span(`Same patch also in: ${attribution.equivalents.map((e) => `${e.pr === null ? "?" : `#${e.pr}`} ${e.oid.slice(0, 7)}`).join(", ")}`, { fg: theme.warning })]);
    }

    if (preview && preview.lines.length > 0 && height - lines.length > 2) {
      lines.push([]);
      lines.push(...this.scrolledPreview(entry, preview, height - lines.length, lines.length));
    }
    return lines.slice(0, height).map((line) => fit(line, width));
  }

  /**
   * Returns the visible part of the preview diff for `room` panel rows, starting at panel row `top`.
   * A marker row replaces the first or last visible row when lines are scrolled out of view.
   */
  private scrolledPreview(entry: Entry, preview: RenderedDiff, room: number, top: number): Line[] {
    const total = preview.lines.length;
    if (total <= room) this.previewScroll = 0;
    else this.previewScroll = Math.min(this.previewScroll, total - (room - 1));
    const scroll = this.previewScroll;
    const showTop = scroll > 0;
    let body = room - (showTop ? 1 : 0);
    const showBottom = scroll + body < total;
    if (showBottom) body -= 1;
    const out: Line[] = [];
    if (showTop) out.push([span(`↑ ${scroll} line${scroll === 1 ? "" : "s"} above · scroll or K`, { fg: theme.muted })]);
    this.visibleDiff = { row0: top + out.length, scroll, actions: preview.actions };
    out.push(...preview.lines.slice(scroll, scroll + body));
    const below = total - scroll - body;
    if (showBottom) out.push([span(`↓ ${below} line${below === 1 ? "" : "s"} below · scroll or J · Enter for the full diff · ${this.contextLabel(entry, "preview")}`, { fg: theme.muted })]);
    return out;
  }

  private diffLines(entry: Entry, rendered: RenderedDiff, width: number, height: number): Line[] {
    const diff = rendered.lines;
    const header: Line = [
      span(`${entry.label} `, { fg: theme.pr, bold: true }),
      span(entry.changes.length === 1 ? entry.lastOid.slice(0, 7) : `${entry.firstOid.slice(0, 7)}..${entry.lastOid.slice(0, 7)}`, { fg: theme.accent }),
      span(`  ${this.options.model.commits.get(entry.lastOid)?.subject ?? ""}`, { fg: theme.muted }),
      span(`  [${RENDERER_NAMES[this.diffRenderer]} · ${this.contextLabel(entry, "full")}]`, { fg: theme.muted }),
    ];
    const room = Math.max(1, height - 2);
    const maxScroll = Math.max(0, diff.length - room);
    this.diffScroll = Math.min(this.diffScroll, maxScroll);
    // The header line is panel row 0, so the first diff line is row 1.
    this.visibleDiff = { row0: 1, scroll: this.diffScroll, actions: rendered.actions };
    const body = diff.slice(this.diffScroll, this.diffScroll + room);
    const position: Line = [span(diff.length === 0 ? "No text diff." : `Lines ${this.diffScroll + 1}-${Math.min(diff.length, this.diffScroll + room)} of ${diff.length}`, { fg: theme.muted })];
    return [header, ...body, position].map((line) => fit(line, width));
  }

  private helpLines(): Line[] {
    const model = this.options.model;
    const keys: [string, string][] = [
      ["j / k", "Select the next or previous file"],
      ["h / l", "Move backward or forward through the file's changes"],
      ["Enter", "Show the full diff of the selected change"],
      ["e", "Show 10 more hidden lines at each end of every hidden region, in the preview or the diff view"],
      ["E", "Show the whole file, or return to the changes, in the preview or the diff view"],
      ["J / K", "Scroll the preview in the selected change panel"],
      ["t", "In the diff view, switch the diff renderer: pierre, delta (if installed), built-in"],
      ["mouse", "Click a file or a listed commit to select it, click a Show action on a ⋯ row to reveal hidden lines, click the change panel to open the diff, scroll the preview or the diff"],
      ["D", "Open the selected diff in a pager: delta in delta mode, Git's pager otherwise"],
      ["Esc", "Return to the file history, or clear the search"],
      ["p", "Switch between the commit timeline and the PR timeline"],
      ["o", "Open the selected PR in tuicr"],
      ["O", "Open the selected commit in tuicr"],
      ["/", "Search file paths"],
      ["a", "In focus mode, switch between the focus PR's files and all files"],
      ["r", "Write a Markdown report for the selected change's PR"],
      ["R", "Write a Markdown report for all loaded PRs"],
      ["y", "Copy the last report (or a new one for the selected PR) to the clipboard"],
      ["q", "Quit"],
    ];
    const lines: Line[] = keys.map(([key, text]) => [span(key.padEnd(8), { fg: theme.accent }), span(text)]);
    const notes = [...model.skipped.map((s) => `Skipped PR #${s.number}: ${s.reason}.`), ...model.stale.map((s) => s.message), ...model.warnings];
    if (notes.length > 0) {
      lines.push([], [span("Notes", { fg: theme.warning, bold: true })]);
      for (const note of notes) lines.push([span(`- ${note}`)]);
    }
    lines.push([], [span("Press any key to return.", { fg: theme.muted })]);
    return lines;
  }

  // ----- Actions -----

  private reportFocus(): number | null {
    return this.currentEntry()?.entry.pr ?? this.options.model.focus;
  }

  private async buildReport(all: boolean): Promise<{ text: string; name: string }> {
    const focus = all ? null : this.reportFocus();
    const options = { maxDiffLines: this.options.maxDiffLines };
    if (focus === null) {
      return { text: await selectionReport(this.options.model, this.options.analyzer, options), name: "commit-trail-selection.md" };
    }
    return { text: await focusReport(this.options.model, this.options.analyzer, focus, options), name: `commit-trail-pr-${focus}.md` };
  }

  private async writeReport(all: boolean): Promise<void> {
    this.status = "Writing report…";
    this.render();
    try {
      const report = await this.buildReport(all);
      await mkdir(this.options.reportDir, { recursive: true });
      const path = join(this.options.reportDir, report.name);
      await Bun.write(path, report.text);
      this.lastReport = report.text;
      this.status = `Report written to ${path}. Press y to copy it.`;
    } catch (error) {
      this.status = `Report failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private async copyReport(): Promise<void> {
    try {
      const text = this.lastReport ?? (await this.buildReport(false)).text;
      this.lastReport = text;
      const tool = await copyToClipboard(text);
      if (tool) this.status = `Report copied with ${tool}.`;
      else if (this.renderer.copyToClipboardOSC52(text)) this.status = "Report sent to the terminal clipboard (OSC 52).";
      else this.status = "No clipboard tool is available. Press r to write the report to a file.";
    } catch (error) {
      this.status = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  /** Shows the selected diff in delta (in delta mode) or in Git's configured pager (in built-in mode). */
  private async openPager(): Promise<void> {
    const current = this.currentEntry();
    if (!current) return;
    const { entry } = current;
    const parent = this.options.model.commits.get(entry.firstOid)?.parents[0] ?? null;
    const command = pagerCommand(entry.changes.length === 1 ? null : parent, entry.lastOid, this.entryPaths(entry), this.diffRenderer === "delta");
    const launch = this.options.launch ?? ((cmd, env) => launchInTerminal(this.renderer, cmd, this.options.git.root, env));
    const exitCode = await launch(command, pagerEnvironment(process.env.LESS));
    this.status = exitCode === 0 ? "Returned from the pager." : `${command.join(" ")} exited with status ${exitCode}.`;
    this.render();
  }

  private async openTuicr(commit: boolean): Promise<void> {
    const current = this.currentEntry();
    if (!current) return;
    const { entry, file } = current;
    let command: string[];
    if (commit) {
      const parent = this.options.model.commits.get(entry.firstOid)?.parents[0] ?? null;
      command = tuicrCommandForCommit(parent, entry.lastOid, file.path);
    } else if (entry.pr !== null) {
      command = tuicrCommandForPullRequest(entry.pr);
    } else {
      this.status = "This change has no unique PR. Press O to open the commit instead.";
      return this.render();
    }
    const launch = this.options.launch ?? ((cmd) => launchInTerminal(this.renderer, cmd, this.options.git.root));
    const exitCode = await launch(command);
    this.status = exitCode === 0 ? `Returned from ${command.join(" ")}.` : `${command.join(" ")} exited with status ${exitCode}.`;
    this.render();
  }
}

/**
 * Shortens a diff for the preview panel: keeps hunk headers, changed lines,
 * and at most `context` unchanged lines on each side of a change.
 */
export function compactDiff(lines: string[], context: number): string[] {
  const changed = lines.map((line) => line.startsWith("+") || line.startsWith("-"));
  return lines.filter((line, index) => {
    if (line.startsWith("@@") || changed[index]) return true;
    for (let offset = 1; offset <= context; offset++) {
      if (changed[index - offset] || changed[index + offset]) return true;
    }
    return false;
  });
}

const RENDERER_NAMES: Record<DiffRenderer, string> = { delta: "delta", pierre: "pierre", builtin: "built-in" };

/** A change to the shown entry within this many milliseconds of the previous change counts as rapid. */
const RAPID_SELECTION_MS = 150;

/** During rapid selection changes, an entry loads its diff after it stays selected for this many milliseconds. */
const SETTLE_MS = 80;

/** Context line count that makes Git include every line of the file. */
const WHOLE_FILE = 1_000_000;

/** Identifies one file's change. One commit can change several files, so the key includes the path. */
function entryKey(entry: Entry): string {
  return `${entry.firstOid}..${entry.lastOid}:${entry.changes[entry.changes.length - 1]!.path}`;
}

/** Colors one built-in diff line and replaces a `@@` header with a readable heading. */
function builtinDiffLine(text: string): Line {
  const header = parseHunkHeader(text);
  if (!header) return diffLine(text);
  return [
    span(describeHunk(header.oldStart, header.oldCount, header.newStart, header.newCount), { fg: theme.hunk, bold: true }),
    span(header.context ? ` · ${header.context}` : "", { fg: theme.muted }),
  ];
}

/** Removes blank lines from the start of rendered output. */
function trimBlankStart(lines: Line[]): Line[] {
  const first = lines.findIndex((line) => line.some((part) => part.text.trim() !== ""));
  return first === -1 ? [] : lines.slice(first);
}

/** Returns the typed character for a key without Ctrl or Alt, or an empty string. */
function printable(key: KeyEvent): string {
  if (key.ctrl || key.meta) return "";
  const text = key.sequence ?? "";
  return [...text].length === 1 && text >= " " && text !== "\x7f" ? text : "";
}

/**
 * Returns the environment for Git's pager. Git sets LESS=FRX when LESS is unset, and F makes less exit
 * at once when the diff fits on one screen, which would return to commit-trail before the user reads it.
 * The result keeps the user's LESS options and turns F off with `-+F`.
 */
export function pagerEnvironment(less: string | undefined): Record<string, string> {
  return { LESS: `${less && less.trim() !== "" ? less.trim() : "-R"} -+F` };
}

/**
 * Returns the Git command that shows a diff in a pager.
 * Without `from`, it shows the single commit `to` with its message. With `from`, it shows the range diff.
 * With `delta`, Git pipes the diff to `delta --paging=always`. delta with its default `--paging=auto`
 * passes `--quit-if-one-screen` to less, which closes a short diff at once. Otherwise Git uses its own pager.
 */
export function pagerCommand(from: string | null, to: string, paths: string[], delta: boolean): string[] {
  const git = delta ? ["git", "-c", "core.pager=delta --paging=always"] : ["git"];
  return from ? [...git, "diff", from, to, "--", ...paths] : [...git, "show", to, "--", ...paths];
}

function mergeOrigins(origins: LineOrigin[]): LineOrigin[] {
  const merged = new Map<string, LineOrigin>();
  for (const origin of origins) {
    const existing = merged.get(origin.oid);
    if (existing) {
      existing.replaced += origin.replaced;
      existing.adjacent += origin.adjacent;
    } else merged.set(origin.oid, { ...origin });
  }
  return [...merged.values()];
}

async function launchInTerminal(renderer: CliRenderer, command: string[], cwd: string, env?: Record<string, string>): Promise<number> {
  if (!Bun.which(command[0]!)) return 127;
  await renderer.suspend();
  try {
    const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
    return await child.exited;
  } finally {
    await renderer.resume();
  }
}

/** Starts the interactive interface and resolves when the user quits. */
export async function runTui(options: AppOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  const app = new TrailApp(renderer, options);
  renderer.keyInput.on("keypress", (key) => app.handleKey(key));
  await new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
}
