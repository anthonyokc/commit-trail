import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./process.ts";
import type { PullRequest, PullRequestState, RepositoryInfo } from "./types.ts";

export type PullRequestSummary = Omit<PullRequest, "commits"> & { commitCount: number };

export interface LookupResult {
  found: PullRequestSummary[];
  missing: number[];
}

/** Supplies pull request metadata. The GitHub CLI implements it in production; tests use fakes. */
export interface PullRequestSource {
  repository(): Promise<RepositoryInfo>;
  openPullRequests(): Promise<PullRequestSummary[]>;
  pullRequests(numbers: number[]): Promise<LookupResult>;
  commits(pr: PullRequestSummary): Promise<string[]>;
}

const PR_FIELDS = `
  number title url state isDraft
  author { login }
  baseRefName headRefName headRefOid isCrossRepository
  commits { totalCount }
`;

const MAX_OPEN_PULL_REQUESTS = 500;
const LOOKUP_CHUNK = 50;

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  author: { login: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  commits: { totalCount: number };
}

function toSummary(raw: RawPullRequest): PullRequestSummary {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    author: raw.author?.login ?? "ghost",
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    isCrossRepository: raw.isCrossRepository,
    commitCount: raw.commits.totalCount,
  };
}

/** Reads pull request metadata with the GitHub CLI (`gh`). Never writes to GitHub. */
export class GhSource implements PullRequestSource {
  private repo: RepositoryInfo | null = null;

  constructor(private readonly cwd: string) {}

  private async gh(args: string[], allowErrors = false): Promise<string> {
    const result = await run(["gh", ...args], { cwd: this.cwd });
    if (result.exitCode === 127) throw new Error("The GitHub CLI (gh) is not installed. Install it from https://cli.github.com.");
    if (result.exitCode !== 0 && !(allowErrors && result.stdout.trim().startsWith("{"))) {
      throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
  }

  private async graphql<T>(query: string, variables: Record<string, string | number>, allowErrors = false): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    const body = JSON.parse(await this.gh(args, allowErrors)) as { data: T };
    return body.data;
  }

  async repository(): Promise<RepositoryInfo> {
    if (this.repo) return this.repo;
    const view = JSON.parse(await this.gh(["repo", "view", "--json", "owner,name"])) as { owner: { login: string }; name: string };
    const data = await this.graphql<{ repository: { defaultBranchRef: { name: string; target: { oid: string } } | null } }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name target { oid } } } }`,
      { owner: view.owner.login, name: view.name },
    );
    this.repo = {
      owner: view.owner.login,
      name: view.name,
      defaultBranch: data.repository.defaultBranchRef?.name ?? "main",
      defaultBranchOid: data.repository.defaultBranchRef?.target.oid ?? null,
    };
    return this.repo;
  }

  async openPullRequests(): Promise<PullRequestSummary[]> {
    const repo = await this.repository();
    const results: PullRequestSummary[] = [];
    let cursor: string | null = null;
    do {
      type Page = {
        repository: { pullRequests: { nodes: RawPullRequest[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      };
      const data: Page = await this.graphql<Page>(
        `query($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
              nodes { ${PR_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        cursor ? { owner: repo.owner, name: repo.name, cursor } : { owner: repo.owner, name: repo.name },
      );
      const page = data.repository.pullRequests;
      results.push(...page.nodes.map(toSummary));
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor && results.length < MAX_OPEN_PULL_REQUESTS);
    return results;
  }

  async pullRequests(numbers: number[]): Promise<LookupResult> {
    const repo = await this.repository();
    const found: PullRequestSummary[] = [];
    const missing: number[] = [];
    for (let start = 0; start < numbers.length; start += LOOKUP_CHUNK) {
      const chunk = numbers.slice(start, start + LOOKUP_CHUNK);
      const fields = chunk.map((n) => `pr${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join("\n");
      const data = await this.graphql<{ repository: Record<string, RawPullRequest | null> }>(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
        { owner: repo.owner, name: repo.name },
        true,
      );
      for (const n of chunk) {
        const raw = data?.repository?.[`pr${n}`];
        if (raw) found.push(toSummary(raw));
        else missing.push(n);
      }
    }
    return { found, missing };
  }

  async commits(pr: PullRequestSummary): Promise<string[]> {
    const repo = await this.repository();
    const output = await this.gh(["api", "--paginate", `repos/${repo.owner}/${repo.name}/pulls/${pr.number}/commits?per_page=100`, "--jq", ".[].sha"]);
    return output.split("\n").filter(Boolean);
  }
}

interface CacheFile {
  version: 1;
  repository?: RepositoryInfo;
  openNumbers?: number[];
  pulls: Record<string, PullRequestSummary>;
  /** Pull request commit lists, indexed by the head commit SHA they were read at. */
  commitsByHead: Record<string, string[]>;
}

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "commit-trail");
}

/**
 * Wraps a source with a local JSON cache.
 * Commit lists are stored by head SHA, so a pushed or rebased branch gets a new entry automatically.
 * In offline mode, every read comes from the cache, and a missing entry raises an error.
 */
export class CachedSource implements PullRequestSource {
  private data: CacheFile = { version: 1, pulls: {}, commitsByHead: {} };
  private path = "";
  private dirty = false;

  private constructor(
    private readonly inner: PullRequestSource | null,
    private readonly cacheDir: string,
    private readonly refresh: boolean,
  ) {}

  static async create(options: { inner: PullRequestSource | null; cacheDir: string; repoKey: string; refresh?: boolean }) {
    const source = new CachedSource(options.inner, options.cacheDir, options.refresh ?? false);
    source.path = join(options.cacheDir, "github", `${options.repoKey.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    const file = Bun.file(source.path);
    if (await file.exists()) {
      try {
        const parsed = (await file.json()) as CacheFile;
        if (parsed.version === 1) source.data = parsed;
      } catch {
        // A corrupt cache file is replaced on the next save.
      }
    }
    return source;
  }

  private requireOnline(what: string): PullRequestSource {
    if (!this.inner) throw new Error(`Offline mode has no cached ${what}. Run once without --offline to fill the cache.`);
    return this.inner;
  }

  async repository(): Promise<RepositoryInfo> {
    if (!this.inner) {
      if (!this.data.repository) this.requireOnline("repository metadata");
      return this.data.repository!;
    }
    const repo = await this.inner.repository();
    this.data.repository = repo;
    this.dirty = true;
    return repo;
  }

  async openPullRequests(): Promise<PullRequestSummary[]> {
    if (!this.inner) {
      if (!this.data.openNumbers) this.requireOnline("open pull request list");
      return this.data.openNumbers!.map((n) => this.data.pulls[n]).filter((pr): pr is PullRequestSummary => pr !== undefined);
    }
    const prs = await this.inner.openPullRequests();
    this.data.openNumbers = prs.map((pr) => pr.number);
    for (const pr of prs) this.data.pulls[pr.number] = pr;
    this.dirty = true;
    return prs;
  }

  async pullRequests(numbers: number[]): Promise<LookupResult> {
    if (!this.inner) {
      const found = numbers.map((n) => this.data.pulls[n]).filter((pr): pr is PullRequestSummary => pr !== undefined);
      const missing = numbers.filter((n) => !this.data.pulls[n]);
      return { found, missing };
    }
    const result = await this.inner.pullRequests(numbers);
    for (const pr of result.found) this.data.pulls[pr.number] = pr;
    this.dirty = true;
    return result;
  }

  async commits(pr: PullRequestSummary): Promise<string[]> {
    const cached = this.data.commitsByHead[pr.headRefOid];
    if (cached && (!this.refresh || !this.inner)) return cached;
    const commits = await this.requireOnline(`commits for PR #${pr.number}`).commits(pr);
    this.data.commitsByHead[pr.headRefOid] = commits;
    this.dirty = true;
    return commits;
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await Bun.write(this.path, JSON.stringify(this.data));
    this.dirty = false;
  }
}
