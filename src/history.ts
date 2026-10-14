import type { Ancestry } from "./attribution.ts";
import type { RawFileChange } from "./git.ts";
import type { CommitAttribution, FileChange, FileHistory } from "./types.ts";

/** Returns true when the attribution assigns the commit to a selected pull request, alone or as one candidate. */
export function isSelectedCommit(attribution: CommitAttribution, selected: Set<number>): boolean {
  if (attribution.copyOf) return false;
  if (attribution.owner !== null) return selected.has(attribution.owner);
  return attribution.candidates.some((pr) => selected.has(pr));
}

/**
 * Groups per-commit file changes into one history per file.
 * A rename joins the old and new paths into one history. The history uses its newest path as its name.
 * Changes appear in topological order. Commits outside the walked graph sort last, by SHA.
 */
export function buildFileHistories(
  commits: string[],
  changesByCommit: Map<string, RawFileChange[]>,
  attributions: Map<string, CommitAttribution>,
  ancestry: Ancestry,
): FileHistory[] {
  const ordered = [...commits].sort((a, b) => ancestry.order(a) - ancestry.order(b) || a.localeCompare(b));

  const parent = new Map<string, string>();
  const find = (path: string): string => {
    let root = path;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(path, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const changes: FileChange[] = [];
  for (const oid of ordered) {
    const attribution = attributions.get(oid);
    for (const raw of changesByCommit.get(oid) ?? []) {
      find(raw.path);
      if (raw.oldPath && raw.status === "R") union(raw.oldPath, raw.path);
      changes.push({
        oid,
        pr: attribution?.owner ?? null,
        candidates: attribution?.candidates ?? [],
        ...raw,
      });
    }
  }

  const groups = new Map<string, FileChange[]>();
  for (const change of changes) {
    const root = find(change.path);
    groups.set(root, [...(groups.get(root) ?? []), change]);
  }

  return [...groups.values()]
    .map((group) => {
      const paths: string[] = [];
      for (const change of group) {
        for (const path of [change.status === "R" ? change.oldPath : undefined, change.path]) if (path && !paths.includes(path)) paths.push(path);
      }
      return { path: group[group.length - 1]!.path, paths, changes: group };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
