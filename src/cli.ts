import type { DiffRendererChoice } from "./delta.ts";
import { parseSelection } from "./selection.ts";

export interface CliOptions {
  command: "tui" | "report" | "help" | "version";
  /** Pull request numbers from the positional arguments. */
  numbers: number[];
  /** Pull request numbers after `--against`, or `null` when the flag is absent. */
  against: number[] | null;
  repo: string;
  remote?: string;
  fetch: boolean;
  offline: boolean;
  refresh: boolean;
  cacheDir?: string;
  output?: string;
  copy: boolean;
  maxDiffLines: number;
  reportDir?: string;
  /** Renderer from `--diff`, or `undefined` so the config file applies. */
  diff?: DiffRendererChoice;
  /** Config file from `--config`, or `undefined` for the default path. */
  config?: string;
}

export const USAGE = `commit-trail: follow each file's changes across GitHub pull requests.

Usage:
  commit-trail [options] [PR...]
  commit-trail report [options] [PR...] [--against PR...]

PR selection:
  (none)         The open pull request of the current branch and its stack
  12             PR #12 plus every open PR that changes one of its files
  1:12, 1-12     PRs #1 through #12, inclusive
  1 2 8 10       Exactly these PRs

Report:
  report 1                    Report on PR #1, compared with related open PRs
  report 1 --against 1:12     Report on PR #1, compared with PRs #1 through #12
  report 1:12                 Report on the file histories of PRs #1 through #12

Options:
  -C, --repo <path>           Repository directory (default: current directory)
      --remote <name>         Git remote for fetching PR commits (default: the remote of the GitHub repository)
      --no-fetch              Do not run git fetch; skip PRs whose commits are missing locally
      --offline               Read GitHub metadata from the cache only; implies --no-fetch
      --refresh               Ignore cached PR commit lists
      --cache-dir <path>      Cache directory (default: $XDG_CACHE_HOME/commit-trail)
  -o, --output <file>         report: write Markdown to <file> instead of standard output
      --copy                  report: copy Markdown to the clipboard
      --max-diff-lines <n>    Diff lines per patch in reports (default: 60)
      --report-dir <path>     Directory for reports written from the interface (default: system temp directory)
      --diff <renderer>       Full diff view: auto, delta, or builtin (default: the config file's diff, else auto)
      --config <path>         Config file (default: $XDG_CONFIG_HOME/commit-trail/config.toml)
  -h, --help                  Show this help
  -V, --version               Show the version

Keys (interface):
  j/k Files   h/l Timeline   Enter Diff   t delta/built-in   D Pager   Esc Back   p PR/commit timeline   o tuicr (PR)   O tuicr (commit)
  a Focus PR files/all files   / Search   r Report (selected PR)   R Report (all PRs)   y Copy report   ? Help and notes   q Quit
`;

/** Parses command-line arguments. Throws an error with a user-facing message for invalid input. */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "tui",
    numbers: [],
    against: null,
    repo: process.cwd(),
    fetch: true,
    offline: false,
    refresh: false,
    copy: false,
    maxDiffLines: 60,
  };
  const positional: string[] = [];
  const against: string[] = [];
  let collectingAgainst = false;

  const args = [...argv];
  if (args[0] === "report") {
    options.command = "report";
    args.shift();
  }

  const value = (flag: string): string => {
    const next = args.shift();
    if (next === undefined || next.startsWith("-")) throw new Error(`${flag} requires a value.`);
    return next;
  };

  while (args.length > 0) {
    const arg = args.shift()!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (inline !== undefined) args.unshift(inline);
    switch (flag) {
      case "-h":
      case "--help":
        options.command = "help";
        return options;
      case "-V":
      case "--version":
        options.command = "version";
        return options;
      case "-C":
      case "--repo":
        options.repo = value(flag);
        break;
      case "--remote":
        options.remote = value(flag);
        break;
      case "--no-fetch":
        options.fetch = false;
        break;
      case "--offline":
        options.offline = true;
        options.fetch = false;
        break;
      case "--refresh":
        options.refresh = true;
        break;
      case "--cache-dir":
        options.cacheDir = value(flag);
        break;
      case "-o":
      case "--output":
        options.output = value(flag);
        break;
      case "--copy":
        options.copy = true;
        break;
      case "--report-dir":
        options.reportDir = value(flag);
        break;
      case "--max-diff-lines": {
        const raw = value(flag);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`--max-diff-lines must be a whole number, not "${raw}".`);
        options.maxDiffLines = n;
        break;
      }
      case "--config":
        options.config = value(flag);
        break;
      case "--diff": {
        const raw = value(flag);
        if (raw !== "auto" && raw !== "delta" && raw !== "builtin") throw new Error(`--diff must be auto, delta, or builtin, not "${raw}".`);
        options.diff = raw;
        break;
      }
      case "--against":
        collectingAgainst = true;
        break;
      default:
        if (flag.startsWith("-")) throw new Error(`Unknown option ${flag}. Run commit-trail --help for usage.`);
        (collectingAgainst ? against : positional).push(arg);
    }
  }

  options.numbers = parseSelection(positional);
  if (collectingAgainst) {
    if (options.command !== "report") throw new Error("--against works only with the report command.");
    if (options.numbers.length !== 1) throw new Error("--against requires exactly one focus PR, for example: commit-trail report 1 --against 1:12");
    options.against = parseSelection(against);
    if (options.against.length === 0) throw new Error("--against requires at least one PR number.");
  }
  if (options.command !== "report" && (options.output || options.copy)) throw new Error("--output and --copy work only with the report command.");
  return options;
}
