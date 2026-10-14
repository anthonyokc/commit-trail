import type { FilePatch, Git } from "./git.ts";
import type { TrailModel } from "./model.ts";
import type { FileChange } from "./types.ts";

/** Lines in a change's pre-image that one earlier commit last modified. */
export interface LineOrigin {
  oid: string;
  pr: number | null;
  /** Lines from the earlier commit that the change removes or replaces. */
  replaced: number;
  /** Unchanged lines from the earlier commit that sit inside the change's hunks, next to the edit. */
  adjacent: number;
}

export interface ChangeAnalysis {
  patch: FilePatch;
  /** Function or section names that Git reports for the hunks, without duplicates. */
  contexts: string[];
  /** Earlier commits from loaded pull requests whose lines this change touches. */
  origins: LineOrigin[];
}

/**
 * Reads a change's patch and finds the loaded commits that wrote the lines it edits.
 * The analysis runs `git blame` on the first parent for each hunk's old range.
 * A removed line counts as replaced. A context line counts as adjacent.
 * Lines from commits outside the loaded pull requests are ignored.
 */
export class ChangeAnalyzer {
  private readonly cache = new Map<string, Promise<ChangeAnalysis>>();

  constructor(
    private readonly git: Git,
    private readonly model: TrailModel,
  ) {}

  analyze(change: FileChange): Promise<ChangeAnalysis> {
    const key = `${change.oid}:${change.path}`;
    let result = this.cache.get(key);
    if (!result) {
      result = this.compute(change);
      this.cache.set(key, result);
    }
    return result;
  }

  private async compute(change: FileChange): Promise<ChangeAnalysis> {
    const paths = change.oldPath && change.oldPath !== change.path ? [change.oldPath, change.path] : [change.path];
    const patch = await this.git.commitPatch(change.oid, paths);
    const contexts = [...new Set(patch.hunks.map((hunk) => hunk.context).filter(Boolean))];

    const parent = this.model.commits.get(change.oid)?.parents[0];
    if (!parent || change.status === "A" || change.binary) return { patch, contexts, origins: [] };

    const ranges = patch.hunks.filter((hunk) => hunk.oldCount > 0).map((hunk) => ({ start: hunk.oldStart, count: hunk.oldCount }));
    const blame = await this.git.blame(parent, change.oldPath ?? change.path, ranges);

    const counts = new Map<string, LineOrigin>();
    for (const hunk of patch.hunks) {
      let line = hunk.oldStart;
      for (const body of hunk.lines) {
        if (body.startsWith("+")) continue;
        const oid = blame.get(line);
        const attribution = oid ? this.model.attributions.get(oid) : undefined;
        if (oid && attribution) {
          const source = attribution.copyOf ?? { oid, pr: attribution.owner };
          const origin = counts.get(source.oid) ?? { oid: source.oid, pr: source.pr, replaced: 0, adjacent: 0 };
          if (body.startsWith("-")) origin.replaced++;
          else origin.adjacent++;
          counts.set(source.oid, origin);
        }
        line++;
      }
    }
    const origins = [...counts.values()].sort(
      (a, b) => this.model.ancestry.order(a.oid) - this.model.ancestry.order(b.oid) || a.oid.localeCompare(b.oid),
    );
    return { patch, contexts, origins };
  }
}
