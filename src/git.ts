import { run, runChecked } from "./process.ts";
import type { ChangeStatus, CommitInfo } from "./types.ts";

export interface RawFileChange {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface WalkedCommit {
  oid: string;
  parents: string[];
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The function or section name that Git prints after the hunk range. */
  context: string;
  /** Hunk body lines, each starting with " ", "-", or "+". */
  lines: string[];
}

export interface FilePatch {
  /** The complete unified diff, including file headers. */
  text: string;
  hunks: DiffHunk[];
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/** Read-only access to one local Git repository, plus `fetch` for missing pull request commits. */
export class Git {
  constructor(readonly root: string) {}

  static async open(cwd: string): Promise<Git> {
    const result = await run(["git", "rev-parse", "--show-toplevel"], { cwd });
    if (result.exitCode !== 0) throw new Error(`${cwd} is not inside a Git repository.`);
    return new Git(result.stdout.trim());
  }

  private exec(args: string[], stdin?: string): Promise<string> {
    return runChecked(["git", "-c", "core.quotepath=off", ...args], { cwd: this.root, stdin });
  }

  async currentBranch(): Promise<string | null> {
    const result = await run(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd: this.root });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async headOid(): Promise<string | null> {
    const result = await run(["git", "rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: this.root });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async remotes(): Promise<{ name: string; url: string }[]> {
    const output = await this.exec(["remote", "-v"]);
    const seen = new Map<string, string>();
    for (const line of output.split("\n")) {
      const [name, url] = line.split(/\s+/);
      if (name && url && !seen.has(name)) seen.set(name, url);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  /** Returns the subset of `oids` that exist locally as commits. */
  async existingCommits(oids: string[]): Promise<Set<string>> {
    if (oids.length === 0) return new Set();
    const output = await this.exec(["cat-file", "--batch-check"], oids.map((oid) => `${oid}^{commit}`).join("\n") + "\n");
    const present = new Set<string>();
    output.split("\n").forEach((line, index) => {
      const oid = oids[index];
      if (oid && / commit \d+$/.test(line)) present.add(oid);
    });
    return present;
  }

  /** Downloads objects for the given refspecs. Writes only FETCH_HEAD; never updates branches. */
  async fetch(remote: string, refspecs: string[]): Promise<{ ok: boolean; error?: string }> {
    if (refspecs.length === 0) return { ok: true };
    const result = await run(["git", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, ...refspecs], {
      cwd: this.root,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    return result.exitCode === 0 ? { ok: true } : { ok: false, error: result.stderr.trim() };
  }

  async commitInfo(oids: string[]): Promise<Map<string, CommitInfo>> {
    const info = new Map<string, CommitInfo>();
    if (oids.length === 0) return info;
    const format = ["%H", "%h", "%s", "%an", "%aI", "%P"].join(FIELD) + RECORD;
    const output = await this.exec(["log", "--no-walk=unsorted", "--stdin", `--format=${format}`], oids.join("\n") + "\n");
    for (const record of output.split(RECORD)) {
      const fields = record.replace(/^\n/, "").split(FIELD);
      const [oid, shortOid, subject, authorName, authorDate, parents] = fields;
      if (!oid || fields.length < 6) continue;
      info.set(oid, {
        oid,
        shortOid: shortOid ?? oid.slice(0, 7),
        subject: subject ?? "",
        authorName: authorName ?? "",
        authorDate: authorDate ?? "",
        parents: parents ? parents.split(" ").filter(Boolean) : [],
      });
    }
    return info;
  }

  /** True when `ancestor` is reachable from `descendant`. A commit counts as its own ancestor. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await run(["git", "merge-base", "--is-ancestor", ancestor, descendant], { cwd: this.root });
    return result.exitCode === 0;
  }

  async mergeBase(oids: string[]): Promise<string | null> {
    if (oids.length === 0) return null;
    if (oids.length === 1) return oids[0] ?? null;
    const result = await run(["git", "merge-base", "--octopus", ...oids], { cwd: this.root });
    return result.exitCode === 0 ? (result.stdout.trim().split("\n")[0] ?? null) : null;
  }

  /** Lists commits reachable from `heads` and not from `exclude`, parents before children. */
  async walk(heads: string[], exclude: string[]): Promise<WalkedCommit[]> {
    if (heads.length === 0) return [];
    const stdin = [...heads, ...exclude.map((oid) => `^${oid}`)].join("\n") + "\n";
    const output = await this.exec(["rev-list", "--topo-order", "--reverse", "--parents", "--stdin"], stdin);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [oid, ...parents] = line.split(" ");
        return { oid: oid!, parents };
      });
  }

  /** Lists the files that each commit changes compared with its first parent, with rename detection. */
  async changedFiles(oids: string[]): Promise<Map<string, RawFileChange[]>> {
    const changes = new Map<string, RawFileChange[]>();
    if (oids.length === 0) return changes;
    const wanted = new Set(oids);
    const stdin = oids.join("\n") + "\n";
    const base = ["diff-tree", "--stdin", "--root", "-r", "-M", "-z"];
    const [statusOutput, numstatOutput] = await Promise.all([
      this.exec([...base, "--name-status"], stdin),
      this.exec([...base, "--numstat"], stdin),
    ]);

    const statuses = new Map<string, { status: ChangeStatus; path: string; oldPath?: string }[]>();
    let current: string | null = null;
    const tokens = statusOutput.split("\0");
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token === "") continue;
      if (wanted.has(token)) {
        current = token;
        statuses.set(current, []);
        continue;
      }
      if (!current) continue;
      const status = token[0] as ChangeStatus;
      if (status === "R" || status === "C") {
        const oldPath = tokens[++index]!;
        const path = tokens[++index]!;
        statuses.get(current)!.push({ status, path, oldPath });
      } else {
        statuses.get(current)!.push({ status, path: tokens[++index]! });
      }
    }

    const counts = new Map<string, Map<string, { additions: number; deletions: number; binary: boolean }>>();
    current = null;
    const numTokens = numstatOutput.split("\0");
    for (let index = 0; index < numTokens.length; index++) {
      const token = numTokens[index]!;
      if (token === "") continue;
      if (wanted.has(token)) {
        current = token;
        counts.set(current, new Map());
        continue;
      }
      if (!current) continue;
      const [added, deleted, inlinePath] = token.split("\t");
      let path = inlinePath ?? "";
      if (path === "") {
        index++;
        path = numTokens[++index]!;
      }
      const binary = added === "-";
      counts.get(current)!.set(path, {
        additions: binary ? 0 : Number(added),
        deletions: binary ? 0 : Number(deleted),
        binary,
      });
    }

    for (const oid of oids) {
      const files = statuses.get(oid) ?? [];
      const fileCounts = counts.get(oid);
      changes.set(
        oid,
        files.map((file) => ({ ...file, ...(fileCounts?.get(file.path) ?? { additions: 0, deletions: 0, binary: false }) })),
      );
    }
    return changes;
  }

  /** Maps commit SHA to stable patch ID. Merge commits and empty commits have no patch ID. */
  async patchIds(oids: string[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (oids.length === 0) return ids;
    const patches = await this.exec(["log", "--no-walk=unsorted", "--stdin", "-p", "--no-color", "--format=commit %H"], oids.join("\n") + "\n");
    const output = await this.exec(["patch-id", "--stable"], patches);
    for (const line of output.split("\n")) {
      const [patchId, oid] = line.split(" ");
      if (patchId && oid) ids.set(oid, patchId);
    }
    return ids;
  }

  /** Returns one commit's diff against its first parent, limited to the given paths. */
  async commitPatch(oid: string, paths: string[], contextLines = 3): Promise<FilePatch> {
    const text = await this.exec([
      "diff-tree",
      "-p",
      "-M",
      "--root",
      "--no-commit-id",
      "--no-color",
      `-U${contextLines}`,
      oid,
      "--",
      ...paths,
    ]);
    return { text, hunks: parseHunks(text) };
  }

  /** Returns the diff between two commits, limited to the given paths. */
  async rangePatch(from: string | null, to: string, paths: string[], contextLines = 3): Promise<FilePatch> {
    const text = from
      ? await this.exec(["diff", "-M", "--no-color", `-U${contextLines}`, from, to, "--", ...paths])
      : await this.exec(["diff-tree", "-p", "-M", "--root", "--no-commit-id", "--no-color", `-U${contextLines}`, to, "--", ...paths]);
    return { text, hunks: parseHunks(text) };
  }

  /**
   * Returns the commit that last changed each line of `path` at `revision`.
   * The result maps line number to commit SHA for every requested range.
   */
  async blame(revision: string, path: string, ranges: { start: number; count: number }[]): Promise<Map<number, string>> {
    const lines = new Map<number, string>();
    const valid = ranges.filter((range) => range.count > 0 && range.start > 0);
    if (valid.length === 0) return lines;
    const args = ["blame", "--porcelain", ...valid.flatMap((range) => ["-L", `${range.start},+${range.count}`]), revision, "--", path];
    const result = await run(["git", ...args], { cwd: this.root });
    if (result.exitCode !== 0) return lines;
    for (const line of result.stdout.split("\n")) {
      const match = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line);
      if (match) lines.set(Number(match[2]), match[1]!);
    }
    return lines;
  }
}

export function parseHunks(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of text.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        context: header[5]?.trim() ?? "",
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("diff --git")) {
      current = null;
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) current.lines.push(line);
  }
  return hunks;
}
