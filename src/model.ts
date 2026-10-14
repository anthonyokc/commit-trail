import { Ancestry, attributeCommits, type StaleNotice } from "./attribution.ts";
import type { Git } from "./git.ts";
import type { PullRequestSource, PullRequestSummary } from "./github.ts";
import { buildFileHistories, isSelectedCommit } from "./history.ts";
import type {
  ChangeRelation,
  CommitAttribution,
  CommitInfo,
  FileChange,
  FileHistory,
  PullRequest,
  RepositoryInfo,
  SkippedPullRequest,
} from "./types.ts";

export type SelectionRequest =
  /** The pull request chain of the current branch. */
  | { kind: "auto" }
  /** Exactly these pull requests. `focus`, when set, must be one of them. */
  | { kind: "explicit"; numbers: number[]; focus?: number }
  /** One pull request plus every open pull request that changes one of its files. */
  | { kind: "related"; focus: number };

export interface LoadOptions {
  git: Git;
  source: PullRequestSource;
  request: SelectionRequest;
  /** Remote for `git fetch`. Defaults to the remote whose URL names the GitHub repository. */
  remote?: string;
  /** Download missing pull request commits with `git fetch`. */
  fetch: boolean;
  progress?: (message: string) => void;
}

export interface TrailModel {
  repository: RepositoryInfo;
  branch: string | null;
  /** Every loaded pull request, including context pull requests used only for attribution. */
  prs: Map<number, PullRequest>;
  /** Selected pull request numbers, ascending. */
  selected: number[];
  focus: number | null;
  commits: Map<string, CommitInfo>;
  attributions: Map<string, CommitAttribution>;
  ancestry: Ancestry;
  histories: FileHistory[];
  skipped: SkippedPullRequest[];
  stale: StaleNotice[];
  warnings: string[];
}

const COMMIT_LIST_CONCURRENCY = 6;

export async function loadTrail(options: LoadOptions): Promise<TrailModel> {
  const { git, source, request } = options;
  const progress = options.progress ?? (() => {});
  const warnings: string[] = [];
  const skipped: SkippedPullRequest[] = [];

  progress("Reading repository metadata");
  const repository = await source.repository();
  const branch = await git.currentBranch();
  const open = await source.openPullRequests();
  const summaries = new Map(open.map((pr) => [pr.number, pr]));

  const requested = request.kind === "explicit" ? request.numbers : request.kind === "related" ? [request.focus] : [];
  const lookup = requested.filter((n) => !summaries.has(n));
  if (lookup.length > 0) {
    progress(`Looking up ${lookup.length} pull request${lookup.length === 1 ? "" : "s"}`);
    const result = await source.pullRequests(lookup);
    for (const pr of result.found) summaries.set(pr.number, pr);
    for (const n of result.missing) skipped.push({ number: n, reason: "no pull request with this number" });
  }

  // Make every head commit available locally, so ancestry covers context pull requests too.
  const remote = options.remote ?? (await resolveRemote(git, repository));
  const heads = [...summaries.values()].map((pr) => pr.headRefOid);
  let present = await git.existingCommits(heads);
  const missingHeads = [...summaries.values()].filter((pr) => !present.has(pr.headRefOid));
  if (missingHeads.length > 0 && options.fetch && remote) {
    progress(`Fetching ${missingHeads.length} pull request head${missingHeads.length === 1 ? "" : "s"} from ${remote}`);
    const fetched = await git.fetch(remote, missingHeads.map((pr) => `pull/${pr.number}/head`));
    if (!fetched.ok) warnings.push(`git fetch from ${remote} failed: ${fetched.error}`);
    present = await git.existingCommits(heads);
  }
  for (const pr of [...summaries.values()]) {
    if (present.has(pr.headRefOid)) continue;
    summaries.delete(pr.number);
    if (requested.includes(pr.number) || request.kind === "auto") {
      skipped.push({
        number: pr.number,
        reason: options.fetch ? `head commit ${pr.headRefOid.slice(0, 7)} is not available` : `head commit ${pr.headRefOid.slice(0, 7)} is not available locally (--no-fetch)`,
      });
    }
  }
  const unavailableContext = open.filter((pr) => !summaries.has(pr.number) && !requested.includes(pr.number)).length;
  if (unavailableContext > 0) warnings.push(`${unavailableContext} open pull request heads were unavailable; attribution ignores them.`);

  let selectedNumbers: number[];
  if (request.kind === "auto") selectedNumbers = await resolveBranchChain(git, branch, [...summaries.values()]);
  else selectedNumbers = requested.filter((n) => summaries.has(n));
  if (request.kind !== "auto" && request.focus !== undefined && !summaries.has(request.focus)) {
    throw new Error(`Pull request #${request.focus} could not be loaded: ${skipped.find((s) => s.number === request.focus)?.reason ?? "unknown error"}.`);
  }

  // Commit lists are required for selected pull requests. Related mode also needs them for every open pull request.
  const needLists = request.kind === "related" ? [...summaries.keys()] : selectedNumbers;
  progress(`Reading commit lists for ${needLists.length} pull request${needLists.length === 1 ? "" : "s"}`);
  const lists = new Map<number, string[]>();
  await mapLimit(needLists, COMMIT_LIST_CONCURRENCY, async (n) => {
    lists.set(n, await source.commits(summaries.get(n)!));
  });

  const listed = [...new Set([...lists.values()].flat())];
  const available = await git.existingCommits(listed);
  const unavailableCommits = listed.filter((oid) => !available.has(oid));
  if (unavailableCommits.length > 0) warnings.push(`${unavailableCommits.length} listed commits are not available locally and are not shown.`);

  const prs = new Map<number, PullRequest>();
  for (const summary of summaries.values()) {
    const { commitCount: _, ...pr } = summary;
    prs.set(summary.number, { ...pr, commits: (lists.get(summary.number) ?? []).filter((oid) => available.has(oid)) });
  }

  progress("Reading commit ancestry");
  const listedAvailable = listed.filter((oid) => available.has(oid));
  const commits = await git.commitInfo(listedAvailable);
  const listedSet = new Set(listedAvailable);
  const boundary = new Set<string>();
  for (const info of commits.values()) for (const parent of info.parents) if (!listedSet.has(parent)) boundary.add(parent);
  const headOids = [...new Set([...prs.values()].map((pr) => pr.headRefOid))];
  const base = await git.mergeBase([...headOids, ...boundary]);
  const walked = await git.walk(headOids, base ? [base] : []);
  const ancestry = new Ancestry(walked, [...listedAvailable, ...headOids]);

  const nonMerge = listedAvailable.filter((oid) => (commits.get(oid)?.parents.length ?? 0) <= 1);
  const patchIds = await git.patchIds(nonMerge);
  const { attributions, stale } = attributeCommits([...prs.values()], ancestry, patchIds);

  const nonMergeSet = new Set(nonMerge);
  if (request.kind === "related") {
    progress("Finding pull requests that change the same files");
    const contextCommits = [...attributions.values()].filter((a) => !a.copyOf && nonMergeSet.has(a.oid)).map((a) => a.oid);
    const contextHistories = buildFileHistories(contextCommits, await git.changedFiles(contextCommits), attributions, ancestry);
    const related = new Set<number>([request.focus]);
    for (const history of contextHistories) {
      if (!history.changes.some((change) => changeBelongsTo(change, request.focus))) continue;
      for (const change of history.changes) {
        if (change.pr !== null) related.add(change.pr);
        else change.candidates.forEach((pr) => related.add(pr));
      }
    }
    selectedNumbers = [...related];
  }

  const selected = new Set(selectedNumbers);
  const selectedCommits = [...attributions.values()].filter((a) => nonMergeSet.has(a.oid) && isSelectedCommit(a, selected)).map((a) => a.oid);
  progress(`Reading file changes for ${selectedCommits.length} commits`);
  const histories = buildFileHistories(selectedCommits, await git.changedFiles(selectedCommits), attributions, ancestry);

  const mergeCount = [...attributions.values()].filter((a) => !nonMergeSet.has(a.oid) && isSelectedCommit(a, selected)).length;
  if (mergeCount > 0) warnings.push(`${mergeCount} merge commit${mergeCount === 1 ? " is" : "s are"} not shown in file histories.`);
  const ambiguous = selectedCommits.filter((oid) => attributions.get(oid)!.owner === null).length;
  if (ambiguous > 0) warnings.push(`${ambiguous} commit${ambiguous === 1 ? " has" : "s have"} no unique originating pull request; they are marked "?".`);
  const copies = [...attributions.values()].filter((a) => a.copyOf && a.owner !== null && selected.has(a.owner)).length;
  if (copies > 0) warnings.push(`${copies} rebased copy commit${copies === 1 ? " is" : "s are"} hidden because an earlier pull request contains the same patch.`);

  return {
    repository,
    branch,
    prs,
    selected: [...selected].sort((a, b) => a - b),
    focus: request.kind === "auto" ? null : (request.focus ?? null),
    commits,
    attributions,
    ancestry,
    histories,
    skipped: skipped.sort((a, b) => a.number - b.number),
    stale: stale.filter((notice) => selected.has(notice.pr)),
    warnings,
  };
}

export function changeBelongsTo(change: FileChange, pr: number): boolean {
  return change.pr === pr || (change.pr === null && change.candidates.includes(pr));
}

export function relationBetween(model: TrailModel, reference: string, other: string): ChangeRelation {
  return model.ancestry.relation(reference, other);
}

/** Formats the owner of a change as `#4`, or `#4?/#7?` when ownership is ambiguous. */
export function ownerLabel(change: Pick<FileChange, "pr" | "candidates">): string {
  if (change.pr !== null) return `#${change.pr}`;
  if (change.candidates.length === 0) return "?";
  return change.candidates.map((n) => `#${n}?`).join("/");
}

async function resolveRemote(git: Git, repository: RepositoryInfo): Promise<string | undefined> {
  const remotes = await git.remotes();
  const slug = `${repository.owner}/${repository.name}`.toLowerCase();
  const match = remotes.find((remote) => remote.url.toLowerCase().replace(/\.git$/, "").endsWith(slug));
  return match?.name ?? remotes.find((remote) => remote.name === "origin")?.name ?? remotes[0]?.name;
}

/**
 * Selects the open pull request for the current branch and the pull requests stacked with it.
 * Stack membership comes from base branch names and from head commit ancestry.
 */
async function resolveBranchChain(git: Git, branch: string | null, open: PullRequestSummary[]): Promise<number[]> {
  const head = await git.headOid();
  const current =
    open.find((pr) => !pr.isCrossRepository && pr.headRefName === branch && pr.headRefOid === head) ??
    open.find((pr) => !pr.isCrossRepository && pr.headRefName === branch) ??
    open.find((pr) => pr.headRefOid === head);
  if (!current) {
    throw new Error(
      `No open pull request uses the current branch${branch ? ` "${branch}"` : ""}. Pass pull request numbers instead, for example: commit-trail 1:12`,
    );
  }

  const chain = new Set<number>([current.number]);
  const queue = [current];
  while (queue.length > 0) {
    const pr = queue.shift()!;
    for (const other of open) {
      if (chain.has(other.number)) continue;
      const below = !other.isCrossRepository && other.headRefName === pr.baseRefName;
      const above = !pr.isCrossRepository && other.baseRefName === pr.headRefName;
      if (below || above) {
        chain.add(other.number);
        queue.push(other);
      }
    }
  }

  await mapLimit(
    open.filter((pr) => !chain.has(pr.number)),
    8,
    async (pr) => {
      if ((await git.isAncestor(pr.headRefOid, current.headRefOid)) || (await git.isAncestor(current.headRefOid, pr.headRefOid))) {
        chain.add(pr.number);
      }
    },
  );
  return [...chain];
}

async function mapLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  });
  await Promise.all(workers);
}
