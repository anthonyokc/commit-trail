export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

/** Metadata for one GitHub pull request. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  /** True when the head branch lives in a fork. */
  isCrossRepository: boolean;
  /** Commit SHAs that GitHub lists for the pull request, oldest first. */
  commits: string[];
}

export interface RepositoryInfo {
  owner: string;
  name: string;
  defaultBranch: string;
  defaultBranchOid: string | null;
}

export interface CommitInfo {
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  authorDate: string;
  parents: string[];
}

/** The pull request that introduced a commit, as determined from ancestry and base relationships. */
export interface CommitAttribution {
  oid: string;
  /** The originating pull request, or `null` when Git history does not establish exactly one. */
  owner: number | null;
  /** Pull requests that could have introduced the commit. Contains one entry when `owner` is set. */
  candidates: number[];
  /** Every loaded pull request whose GitHub commit list contains the commit. */
  listedIn: number[];
  /** Set when the commit repeats the patch of an earlier commit in a predecessor pull request. */
  copyOf?: { oid: string; pr: number | null };
  /** Commits in other pull requests with the same patch ID, which marks a rebase or cherry-pick. */
  equivalents: { oid: string; pr: number | null }[];
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

/** One commit's change to one file. */
export interface FileChange {
  oid: string;
  /** The originating pull request, or `null` when ownership is ambiguous. */
  pr: number | null;
  candidates: number[];
  status: ChangeStatus;
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** All changes to one file across the selected pull requests, in topological order. */
export interface FileHistory {
  /** The newest path of the file. */
  path: string;
  /** Every path that the file used in the selected changes. */
  paths: string[];
  changes: FileChange[];
}

export interface SkippedPullRequest {
  number: number;
  reason: string;
}

export type ChangeRelation = "earlier" | "later" | "parallel" | "same";
