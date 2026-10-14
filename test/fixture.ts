import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LookupResult, PullRequestSource, PullRequestSummary } from "../src/github.ts";
import { runChecked } from "../src/process.ts";
import type { RepositoryInfo } from "../src/types.ts";

/** A disposable Git repository with helpers for building branch histories. */
export class FixtureRepo {
  private constructor(readonly root: string) {}

  static async create(): Promise<FixtureRepo> {
    const root = await mkdtemp(join(tmpdir(), "commit-trail-test-"));
    const repo = new FixtureRepo(root);
    await repo.git("init", "-q", "-b", "main");
    await repo.git("config", "user.name", "Test");
    await repo.git("config", "user.email", "test@example.com");
    await repo.git("config", "commit.gpgsign", "false");
    return repo;
  }

  git(...args: string[]): Promise<string> {
    return runChecked(["git", ...args], { cwd: this.root }).then((out) => out.trim());
  }

  async checkout(branch: string, from?: string): Promise<void> {
    if (from) await this.git("checkout", "-q", "-b", branch, from);
    else await this.git("checkout", "-q", branch);
  }

  /** Writes files (`null` deletes), commits them, and returns the new commit SHA. */
  async commit(message: string, files: Record<string, string | null>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.root, path);
      if (content === null) {
        await rm(full);
      } else {
        await mkdir(dirname(full), { recursive: true });
        await Bun.write(full, content);
      }
    }
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  async rename(from: string, to: string, message: string): Promise<string> {
    await mkdir(dirname(join(this.root, to)), { recursive: true });
    await this.git("mv", from, to);
    await this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export interface FakePullRequest {
  number: number;
  head: string;
  base: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
}

/**
 * Serves pull requests from local branches.
 * Commit lists follow GitHub: commits reachable from the head branch and not from the base branch.
 */
export class FakeSource implements PullRequestSource {
  constructor(
    private readonly repo: FixtureRepo,
    private readonly prs: FakePullRequest[],
  ) {}

  async repository(): Promise<RepositoryInfo> {
    return { owner: "example", name: "fixture", defaultBranch: "main", defaultBranchOid: await this.repo.git("rev-parse", "main") };
  }

  private async summary(pr: FakePullRequest): Promise<PullRequestSummary> {
    return {
      number: pr.number,
      title: `PR ${pr.number} from ${pr.head}`,
      url: `https://github.com/example/fixture/pull/${pr.number}`,
      state: pr.state ?? "OPEN",
      isDraft: false,
      author: "test",
      baseRefName: pr.base,
      headRefName: pr.head,
      headRefOid: await this.repo.git("rev-parse", pr.head),
      isCrossRepository: false,
      commitCount: 0,
    };
  }

  async openPullRequests(): Promise<PullRequestSummary[]> {
    return Promise.all(this.prs.filter((pr) => (pr.state ?? "OPEN") === "OPEN").map((pr) => this.summary(pr)));
  }

  async pullRequests(numbers: number[]): Promise<LookupResult> {
    const found = await Promise.all(this.prs.filter((pr) => numbers.includes(pr.number)).map((pr) => this.summary(pr)));
    return { found, missing: numbers.filter((n) => !this.prs.some((pr) => pr.number === n)) };
  }

  async commits(summary: PullRequestSummary): Promise<string[]> {
    const pr = this.prs.find((candidate) => candidate.number === summary.number)!;
    const output = await this.repo.git("rev-list", "--reverse", pr.head, `^${pr.base}`);
    return output.split("\n").filter(Boolean);
  }
}

/** Builds a file of `count` numbered filler lines with `replacements` at 1-based line numbers. */
export function numberedFile(count: number, replacements: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, index) => replacements[index + 1] ?? `line ${index + 1}`).join("\n") + "\n";
}
