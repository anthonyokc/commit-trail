import type { ChangeAnalysis, ChangeAnalyzer } from "./analysis.ts";
import { changeBelongsTo, ownerLabel, type TrailModel } from "./model.ts";
import { formatNumbers } from "./selection.ts";
import type { FileChange, FileHistory } from "./types.ts";
import { VERSION } from "./version.ts";

export type Finding = "Potentially superseded change" | "Code overlap" | "File overlap";

export interface ComparedChange {
  change: FileChange;
  relation: "earlier" | "later" | "parallel";
  finding: Finding;
  /** Lines from the focus pull request that a later change replaces or edits next to. */
  replaced: number;
  adjacent: number;
  /** For an earlier change: lines of it that the focus pull request replaces or edits next to. */
  revisedByFocus: number;
}

export interface FileComparison {
  history: FileHistory;
  own: FileChange[];
  others: ComparedChange[];
  status: string;
}

export interface ReportOptions {
  /** Maximum diff lines per patch. Longer patches end with a truncation note. */
  maxDiffLines: number;
  date?: Date;
}

const STATUS_WORD: Record<FileChange["status"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
};

export function changeWord(change: FileChange): string {
  return STATUS_WORD[change.status];
}

/**
 * Compares every other selected change to the focus pull request's changes in each file.
 * A change is later when one of the focus pull request's commits for the file is its ancestor,
 * earlier when it is an ancestor of one of those commits, and parallel otherwise.
 */
export async function compareFocus(model: TrailModel, analyzer: ChangeAnalyzer, focus: number): Promise<FileComparison[]> {
  const comparisons: FileComparison[] = [];
  for (const history of model.histories) {
    const own = history.changes.filter((change) => changeBelongsTo(change, focus));
    if (own.length === 0) continue;
    const ownAnalyses = await Promise.all(own.map((change) => analyzer.analyze(change)));
    const others: ComparedChange[] = [];
    for (const change of history.changes) {
      if (changeBelongsTo(change, focus)) continue;
      const relation = own.some((mine) => model.ancestry.isAncestor(mine.oid, change.oid))
        ? "later"
        : own.some((mine) => model.ancestry.isAncestor(change.oid, mine.oid))
          ? "earlier"
          : "parallel";
      let replaced = 0;
      let adjacent = 0;
      let revisedByFocus = 0;
      if (relation === "later") {
        const analysis = await analyzer.analyze(change);
        for (const origin of analysis.origins) {
          if (origin.pr !== focus) continue;
          replaced += origin.replaced;
          adjacent += origin.adjacent;
        }
      } else if (relation === "earlier") {
        for (const analysis of ownAnalyses) {
          for (const origin of analysis.origins) if (origin.oid === change.oid) revisedByFocus += origin.replaced + origin.adjacent;
        }
      }
      const finding: Finding = replaced > 0 ? "Potentially superseded change" : adjacent > 0 || revisedByFocus > 0 ? "Code overlap" : "File overlap";
      others.push({ change, relation, finding, replaced, adjacent, revisedByFocus });
    }
    comparisons.push({ history, own, others, status: reviewStatus(others) });
  }
  return comparisons;
}

function reviewStatus(others: ComparedChange[]): string {
  if (others.some((other) => other.relation === "later")) return "Inspect later changes";
  if (others.some((other) => other.relation === "parallel")) return "Inspect parallel changes";
  if (others.length > 0) return "Earlier changes only";
  return "No overlap";
}

export async function focusReport(model: TrailModel, analyzer: ChangeAnalyzer, focus: number, options: ReportOptions): Promise<string> {
  const pr = model.prs.get(focus);
  const comparisons = await compareFocus(model, analyzer, focus);
  const out: string[] = [];
  out.push(`# Cross-PR File Review: PR #${focus}`, "");
  if (pr) out.push(`**PR #${focus}:** [${escapeInline(pr.title)}](${pr.url}) by @${pr.author}`, "");
  out.push(...header(model, options));

  out.push("## Summary", "");
  if (comparisons.length === 0) {
    out.push(`PR #${focus} has no file changes in the loaded commits.`, "");
  } else {
    out.push("| File | Other PRs | Later modifications | Findings | Review status |", "|---|---|---|---|---|");
    for (const comparison of comparisons) {
      const otherPrs = unique(comparison.others.map((other) => ownerLabel(other.change)));
      const later = comparison.others.filter((other) => other.relation === "later").length;
      const findings = summarizeFindings(comparison.others);
      out.push(
        `| \`${escapeTable(comparison.history.path)}\` | ${otherPrs.join(", ") || "None"} | ${later} commit${later === 1 ? "" : "s"} | ${findings || "None"} | ${comparison.status} |`,
      );
    }
    out.push("");
  }
  out.push(...findingKey());

  for (const comparison of comparisons) {
    out.push(`## \`${comparison.history.path}\``, "");
    if (comparison.history.paths.length > 1) out.push(`Other paths in this history: ${comparison.history.paths.filter((p) => p !== comparison.history.path).map((p) => `\`${p}\``).join(", ")}.`, "");

    out.push(`### Change in PR #${focus}`, "");
    for (const change of comparison.own) {
      const analysis = await analyzer.analyze(change);
      out.push(...changeHeading(model, change, analysis));
      out.push(...diffBlock(analysis, change, options));
    }

    const ordered = [...comparison.others].sort((a, b) => model.ancestry.order(a.change.oid) - model.ancestry.order(b.change.oid));
    for (const other of ordered) {
      const owner = ownerLabel(other.change);
      const label = other.relation === "later" ? "Later modification" : other.relation === "earlier" ? "Earlier modification" : "Parallel modification";
      out.push(`### ${label} in PR ${owner}`, "");
      const analysis = await analyzer.analyze(other.change);
      out.push(...changeHeading(model, other.change, analysis));
      out.push(`**Finding:** ${other.finding}. ${describeComparison(other, focus)}`, "");
      if (other.relation !== "earlier") out.push(...diffBlock(analysis, other.change, options));
      const note = reviewNote(other, focus);
      if (note) out.push(`**Review note:** ${note}`, "");
    }
    out.push("---", "");
  }
  out.push(...notes(model));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export async function selectionReport(model: TrailModel, analyzer: ChangeAnalyzer, options: ReportOptions): Promise<string> {
  const out: string[] = [];
  out.push(`# Cross-PR File History: ${formatNumbers(model.selected) || "no pull requests"}`, "");
  out.push(...header(model, options));

  const shared = model.histories.filter((history) => unique(history.changes.map(ownerLabel)).length > 1);
  out.push("## Summary", "");
  if (model.histories.length === 0) {
    out.push("The selected pull requests have no file changes in the loaded commits.", "");
  } else {
    out.push("| File | PRs | Commits | Cross-PR revisions |", "|---|---|---|---|");
    for (const history of model.histories) {
      const revisions = await crossRevisions(analyzer, history);
      out.push(
        `| \`${escapeTable(history.path)}\` | ${unique(history.changes.map(ownerLabel)).join(", ")} | ${history.changes.length} | ${revisions.map((r) => `${r.by} revises ${r.of}`).join("; ") || "None"} |`,
      );
    }
    out.push("");
    out.push(`${shared.length} of ${model.histories.length} files change in more than one pull request.`, "");
  }

  for (const history of shared) {
    out.push(`## \`${history.path}\``, "");
    if (history.paths.length > 1) out.push(`Other paths in this history: ${history.paths.filter((p) => p !== history.path).map((p) => `\`${p}\``).join(", ")}.`, "");
    out.push("| # | PR | Commit | Subject | Change | Lines | Revises |", "|---|---|---|---|---|---|---|");
    let index = 1;
    for (const change of history.changes) {
      const info = model.commits.get(change.oid);
      const analysis = await analyzer.analyze(change);
      const revises = analysis.origins
        .filter((origin) => origin.pr !== change.pr)
        .map((origin) => `${origin.replaced > 0 ? `replaces ${origin.replaced}` : `edits next to ${origin.adjacent}`} line${(origin.replaced || origin.adjacent) === 1 ? "" : "s"} from ${origin.pr === null ? "?" : `#${origin.pr}`} \`${origin.oid.slice(0, 7)}\``);
      out.push(
        `| ${index++} | ${ownerLabel(change)} | \`${change.oid.slice(0, 7)}\` | ${escapeTable(info?.subject ?? "")} | ${changeWord(change)} | ${lineSummary(change)} | ${revises.join("; ") || ""} |`,
      );
    }
    out.push("");
    for (const change of history.changes) {
      const analysis = await analyzer.analyze(change);
      const replacedOthers = analysis.origins.filter((origin) => origin.pr !== change.pr && origin.replaced > 0);
      if (replacedOthers.length === 0) continue;
      out.push(`### ${ownerLabel(change)} revises ${unique(replacedOthers.map((o) => (o.pr === null ? "?" : `#${o.pr}`))).join(", ")}`, "");
      out.push(...changeHeading(model, change, analysis));
      out.push(...diffBlock(analysis, change, options));
    }
    out.push("---", "");
  }
  out.push(...notes(model));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function crossRevisions(analyzer: ChangeAnalyzer, history: FileHistory): Promise<{ by: string; of: string }[]> {
  const pairs: { by: string; of: string }[] = [];
  for (const change of history.changes) {
    const analysis = await analyzer.analyze(change);
    for (const origin of analysis.origins) {
      if (origin.pr === change.pr || origin.replaced === 0) continue;
      const pair = { by: ownerLabel(change), of: origin.pr === null ? "?" : `#${origin.pr}` };
      if (!pairs.some((p) => p.by === pair.by && p.of === pair.of)) pairs.push(pair);
    }
  }
  return pairs;
}

function header(model: TrailModel, options: ReportOptions): string[] {
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  return [
    `Comparison: PRs ${formatNumbers(model.selected)} (${model.selected.length} loaded)`,
    "",
    `Repository: ${model.repository.owner}/${model.repository.name}. Generated by commit-trail ${VERSION} on ${date}.`,
    "",
    "This report lists evidence from Git history. It does not decide whether a later change resolves a review concern.",
    "",
  ];
}

function findingKey(): string[] {
  return [
    "| Finding | Meaning |",
    "|---|---|",
    "| File overlap | Another PR modifies the file, but not lines next to this PR's lines. |",
    "| Code overlap | Another PR edits lines next to this PR's lines, or this PR edits lines from another PR. |",
    "| Potentially superseded change | A later PR removes or replaces lines that this PR introduced. |",
    "",
  ];
}

function summarizeFindings(others: ComparedChange[]): string {
  const order: Finding[] = ["Potentially superseded change", "Code overlap", "File overlap"];
  return order
    .map((finding) => {
      const prs = unique(others.filter((other) => other.finding === finding).map((other) => ownerLabel(other.change)));
      return prs.length > 0 ? `${finding.replace(" change", "")} (${prs.join(", ")})` : "";
    })
    .filter(Boolean)
    .join("; ");
}

function describeComparison(other: ComparedChange, focus: number): string {
  if (other.relation === "parallel") return `This commit is on a branch that does not contain PR #${focus}'s change to the file, so Git defines no order between them.`;
  if (other.relation === "earlier") {
    return other.revisedByFocus > 0
      ? `PR #${focus} edits ${other.revisedByFocus} line${other.revisedByFocus === 1 ? "" : "s"} that this commit wrote or that sit next to the edit.`
      : `PR #${focus} builds on this commit but does not edit its lines.`;
  }
  const parts: string[] = [];
  if (other.replaced > 0) parts.push(`removes or replaces ${other.replaced} line${other.replaced === 1 ? "" : "s"} that PR #${focus} introduced`);
  if (other.adjacent > 0) parts.push(`edits next to ${other.adjacent} line${other.adjacent === 1 ? "" : "s"} that PR #${focus} introduced`);
  return parts.length > 0 ? `This commit ${parts.join(" and ")}.` : `This commit changes other lines of the file.`;
}

function reviewNote(other: ComparedChange, focus: number): string | null {
  const owner = ownerLabel(other.change);
  if (other.relation !== "later") return null;
  if (other.finding === "Potentially superseded change") return `PR ${owner} replaces lines that PR #${focus} introduced. Inspect PR ${owner} before you request the same change in PR #${focus}.`;
  if (other.finding === "Code overlap") return `PR ${owner} edits next to lines that PR #${focus} introduced. Inspect PR ${owner} before you comment on this region in PR #${focus}.`;
  return null;
}

function changeHeading(model: TrailModel, change: FileChange, analysis: ChangeAnalysis): string[] {
  const info = model.commits.get(change.oid);
  const lines = [`- Commit \`${change.oid.slice(0, 7)}\`: ${escapeInline(info?.subject ?? "")} (${changeWord(change)}, ${lineSummary(change)})`];
  if (change.status === "R" && change.oldPath) lines.push(`- Renamed from \`${change.oldPath}\``);
  if (analysis.contexts.length > 0) lines.push(`- Hunk context: ${analysis.contexts.map((c) => `\`${c.replace(/`/g, "'")}\``).join(", ")}`);
  lines.push("");
  return lines;
}

function diffBlock(analysis: ChangeAnalysis, change: FileChange, options: ReportOptions): string[] {
  if (change.binary) return ["Binary file; no text diff.", ""];
  const body = patchBody(analysis.patch.text);
  if (body.length === 0) return [];
  const shown = body.slice(0, options.maxDiffLines);
  const lines = ["```diff", ...shown.map((line) => line.replace(/^```/, "` ``")), "```"];
  if (body.length > shown.length) {
    lines.push(`${body.length - shown.length} more diff lines are not shown. Run \`git show ${change.oid.slice(0, 7)} -- ${change.path}\` to read them.`);
  }
  lines.push("");
  return lines;
}

/** Returns the hunk lines of a patch, without file headers. */
export function patchBody(text: string): string[] {
  const lines = text.replace(/\n$/, "").split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  return first === -1 ? [] : lines.slice(first).filter((line) => !line.startsWith("diff --git") && !line.startsWith("index "));
}

export function lineSummary(change: FileChange): string {
  return change.binary ? "binary" : `+${change.additions} -${change.deletions}`;
}

function notes(model: TrailModel): string[] {
  const items = [
    ...model.skipped.map((s) => `Skipped PR #${s.number}: ${s.reason}.`),
    ...model.stale.map((s) => s.message),
    ...model.warnings,
  ];
  if (items.length === 0) return [];
  return ["## Notes", "", ...items.map((item) => `- ${item}`), ""];
}

/** Removes duplicates and sorts labels such as `#4` and `#4?/#7?` by their first PR number. */
function unique(values: string[]): string[] {
  const number = (label: string) => Number(/\d+/.exec(label)?.[0] ?? Number.MAX_SAFE_INTEGER);
  return [...new Set(values)].sort((a, b) => number(a) - number(b) || a.localeCompare(b));
}

function escapeTable(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeInline(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}
