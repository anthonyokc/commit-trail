import type { WalkedCommit } from "./git.ts";
import type { CommitAttribution, PullRequest } from "./types.ts";

/** Answers reachability questions for a fixed set of tracked commits. */
export class Ancestry {
  private readonly bit = new Map<string, bigint>();
  private readonly ancestors = new Map<string, bigint>();
  private readonly position = new Map<string, number>();

  /**
   * @param walked Commits in topological order, parents before children (`git rev-list --topo-order --reverse`).
   * @param tracked Commits whose ancestry the caller queries. Untracked commits only carry reachability.
   */
  constructor(walked: WalkedCommit[], tracked: Iterable<string>) {
    let index = 0n;
    for (const oid of tracked) {
      if (!this.bit.has(oid)) this.bit.set(oid, 1n << index++);
    }
    walked.forEach((commit, order) => {
      let set = 0n;
      for (const parent of commit.parents) {
        set |= this.ancestors.get(parent) ?? 0n;
        set |= this.bit.get(parent) ?? 0n;
      }
      this.ancestors.set(commit.oid, set);
      this.position.set(commit.oid, order);
    });
  }

  has(oid: string): boolean {
    return this.position.has(oid);
  }

  /** Topological position, or `Infinity` for a commit outside the walked graph. */
  order(oid: string): number {
    return this.position.get(oid) ?? Number.POSITIVE_INFINITY;
  }

  /** True when `ancestor` differs from `descendant` and is reachable from it. `ancestor` must be tracked. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return false;
    const bit = this.bit.get(ancestor);
    const set = this.ancestors.get(descendant);
    return bit !== undefined && set !== undefined && (set & bit) !== 0n;
  }

  /** Classifies `other` relative to `reference`. */
  relation(reference: string, other: string): "same" | "earlier" | "later" | "parallel" {
    if (reference === other) return "same";
    if (this.isAncestor(other, reference)) return "earlier";
    if (this.isAncestor(reference, other)) return "later";
    return "parallel";
  }
}

export interface StaleNotice {
  pr: number;
  base: number;
  message: string;
}

export interface AttributionResult {
  attributions: Map<string, CommitAttribution>;
  /** Maps each pull request to the pull requests that it builds on, transitively. */
  predecessors: Map<number, Set<number>>;
  stale: StaleNotice[];
}

/**
 * Assigns each listed commit to the pull request that introduced it.
 *
 * GitHub lists inherited commits in stacked pull requests. A pull request `q` is a predecessor of `p` when
 * `q`'s head commit is an ancestor of `p`'s head commit, or when `p` targets `q`'s head branch.
 * A commit belongs to the candidates that have no predecessor among the other candidates.
 * One remaining candidate becomes the owner. Several remaining candidates leave the commit ambiguous.
 *
 * A commit whose patch ID matches a commit in a predecessor is a copy left by a rebase.
 * A commit whose patch ID matches a commit in an unrelated pull request records an equivalent.
 */
export function attributeCommits(prs: PullRequest[], ancestry: Ancestry, patchIds: Map<string, string>): AttributionResult {
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const predecessors = computePredecessors(prs, ancestry);
  const isPredecessor = (q: number, p: number) => predecessors.get(p)?.has(q) ?? false;

  const listedIn = new Map<string, number[]>();
  for (const pr of prs) {
    for (const oid of pr.commits) {
      const list = listedIn.get(oid) ?? [];
      if (!list.includes(pr.number)) list.push(pr.number);
      listedIn.set(oid, list);
    }
  }

  const attributions = new Map<string, CommitAttribution>();
  for (const [oid, listing] of listedIn) {
    const candidates = new Set(listing);
    // A predecessor whose branch contains the commit is a candidate even when GitHub omits the commit from its list.
    for (const p of listing) {
      for (const q of predecessors.get(p) ?? []) {
        const head = byNumber.get(q)?.headRefOid;
        if (head && (head === oid || ancestry.isAncestor(oid, head))) candidates.add(q);
      }
    }
    const minimal = [...candidates].filter((p) => ![...candidates].some((q) => q !== p && isPredecessor(q, p))).sort((a, b) => a - b);
    attributions.set(oid, {
      oid,
      owner: minimal.length === 1 ? minimal[0]! : null,
      candidates: minimal,
      listedIn: [...listing].sort((a, b) => a - b),
      equivalents: [],
    });
  }

  const byPatch = new Map<string, string[]>();
  for (const [oid, patchId] of patchIds) {
    if (!attributions.has(oid)) continue;
    byPatch.set(patchId, [...(byPatch.get(patchId) ?? []), oid]);
  }
  for (const group of byPatch.values()) {
    if (group.length < 2) continue;
    for (const oid of group) {
      const attribution = attributions.get(oid)!;
      for (const other of group) {
        if (other === oid) continue;
        const otherOwner = attributions.get(other)!.owner;
        if (otherOwner !== null && otherOwner === attribution.owner) continue;
        if (attribution.owner !== null && otherOwner !== null && isPredecessor(otherOwner, attribution.owner)) {
          attribution.copyOf ??= { oid: other, pr: otherOwner };
        } else if (!(attribution.owner !== null && otherOwner !== null && isPredecessor(attribution.owner, otherOwner))) {
          attribution.equivalents.push({ oid: other, pr: otherOwner });
        }
      }
    }
  }

  const stale: StaleNotice[] = [];
  for (const p of prs) {
    for (const q of prs) {
      if (q === p || q.isCrossRepository || q.state !== "OPEN" || p.baseRefName !== q.headRefName) continue;
      if (q.headRefOid === p.headRefOid || ancestry.isAncestor(q.headRefOid, p.headRefOid)) continue;
      if (!ancestry.has(q.headRefOid) || !ancestry.has(p.headRefOid)) continue;
      stale.push({
        pr: p.number,
        base: q.number,
        message: `PR #${p.number} targets ${q.headRefName} (PR #${q.number}) but does not contain its latest commit ${q.headRefOid.slice(0, 7)}. Rebase PR #${p.number} to remove stale copies.`,
      });
    }
  }

  return { attributions, predecessors, stale };
}

function computePredecessors(prs: PullRequest[], ancestry: Ancestry): Map<number, Set<number>> {
  const direct = new Map<number, Set<number>>(prs.map((pr) => [pr.number, new Set<number>()]));
  for (const p of prs) {
    for (const q of prs) {
      if (q === p || q.headRefOid === p.headRefOid) continue;
      const byAncestry = ancestry.isAncestor(q.headRefOid, p.headRefOid);
      const byBase = !q.isCrossRepository && q.state === "OPEN" && p.baseRefName === q.headRefName && q.headRefName !== p.headRefName;
      if (byAncestry || byBase) direct.get(p.number)!.add(q.number);
    }
  }

  // Transitive closure. The pull request count is small, so repeated passes are sufficient.
  let changed = true;
  while (changed) {
    changed = false;
    for (const set of direct.values()) {
      for (const q of [...set]) {
        for (const r of direct.get(q) ?? []) {
          if (!set.has(r)) {
            set.add(r);
            changed = true;
          }
        }
      }
    }
  }

  // A cycle means the relationships contradict each other. Remove both directions instead of choosing one.
  for (const [p, set] of direct) {
    set.delete(p);
    for (const q of [...set]) {
      if (direct.get(q)?.has(p)) {
        set.delete(q);
        direct.get(q)!.delete(p);
      }
    }
  }
  return direct;
}
