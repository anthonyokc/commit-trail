import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChangeAnalyzer } from "./analysis.ts";
import { parseArgs, USAGE, type CliOptions } from "./cli.ts";
import { copyToClipboard } from "./clipboard.ts";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { resolveDiffRenderer } from "./delta.ts";
import { Git } from "./git.ts";
import { CachedSource, defaultCacheDir, GhSource } from "./github.ts";
import { loadTrail, type SelectionRequest } from "./model.ts";
import { focusReport, selectionReport } from "./report.ts";
import { VERSION } from "./version.ts";

function selectionRequest(options: CliOptions): SelectionRequest {
  if (options.against) {
    const focus = options.numbers[0]!;
    return { kind: "explicit", numbers: [focus, ...options.against.filter((n) => n !== focus)], focus };
  }
  if (options.numbers.length === 0) return { kind: "auto" };
  if (options.numbers.length === 1) return { kind: "related", focus: options.numbers[0]! };
  return { kind: "explicit", numbers: options.numbers };
}

/** Derives a stable cache key from the remote URL, so offline mode can find the cache without GitHub. */
async function cacheKey(git: Git, remote: string | undefined): Promise<string> {
  const remotes = await git.remotes();
  const url = (remote ? remotes.find((r) => r.name === remote) : (remotes.find((r) => r.name === "origin") ?? remotes[0]))?.url;
  const match = url ? /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) : null;
  return match ? `${match[1]}__${match[2]}` : git.root;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.command === "version") {
    process.stdout.write(`commit-trail ${VERSION}\n`);
    return 0;
  }

  const git = await Git.open(resolve(options.repo));
  const config = await loadConfig(options.config ?? defaultConfigPath());
  const diffRenderer = options.command === "tui" ? resolveDiffRenderer(options.diff ?? config.diff ?? "auto") : "builtin";
  const source = await CachedSource.create({
    inner: options.offline ? null : new GhSource(git.root),
    cacheDir: options.cacheDir ?? defaultCacheDir(),
    repoKey: await cacheKey(git, options.remote),
    refresh: options.refresh,
  });

  const interactive = options.command === "tui";
  const progress = (message: string) => process.stderr.write(`${message}…\n`);
  const model = await loadTrail({
    git,
    source,
    request: selectionRequest(options),
    remote: options.remote,
    fetch: options.fetch,
    progress,
  });
  await source.save();

  for (const skipped of model.skipped) process.stderr.write(`Skipped PR #${skipped.number}: ${skipped.reason}.\n`);
  if (model.selected.length === 0) {
    process.stderr.write("No pull requests could be loaded.\n");
    return 1;
  }

  const analyzer = new ChangeAnalyzer(git, model);
  if (interactive) {
    const { runTui } = await import("./tui/app.ts");
    await runTui({
      model,
      git,
      analyzer,
      reportDir: options.reportDir ?? join(tmpdir(), "commit-trail"),
      maxDiffLines: options.maxDiffLines,
      diffRenderer,
    });
    return 0;
  }

  const reportOptions = { maxDiffLines: options.maxDiffLines };
  const markdown =
    model.focus !== null
      ? await focusReport(model, analyzer, model.focus, reportOptions)
      : await selectionReport(model, analyzer, reportOptions);

  if (options.output) {
    await Bun.write(options.output, markdown);
    process.stderr.write(`Report written to ${options.output}.\n`);
  }
  if (options.copy) {
    const tool = await copyToClipboard(markdown);
    if (tool) process.stderr.write(`Report copied to the clipboard with ${tool}.\n`);
    else {
      process.stderr.write("No clipboard tool is available (pbcopy, wl-copy, xclip, xsel, or clip.exe).\n");
      return 1;
    }
  }
  if (!options.output && !options.copy) process.stdout.write(markdown);
  return 0;
}

main(Bun.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`commit-trail: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
