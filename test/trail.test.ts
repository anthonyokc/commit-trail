import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChangeAnalyzer } from "../src/analysis.ts";
import { Git } from "../src/git.ts";
import { loadTrail, type SelectionRequest, type TrailModel } from "../src/model.ts";
import { compareFocus, focusReport } from "../src/report.ts";
import { FakeSource, FixtureRepo, numberedFile, type FakePullRequest } from "./fixture.ts";

/*
 * Fixture history (each PR's base in parentheses):
 *
 *   main ── c0
 *            ├── c1 feat-1 (#1, main)      adds get_case_coverage() at lines 5-7 of R/clean.R, adds R/ingest.R
 *            │    ├── c2 feat-2 (#2, feat-1)  replaces line 6, which c1 wrote
 *            │    │    └── c3 feat-3 (#3, main)  edits line 25 and renames R/ingest.R; GitHub lists c1, c2, c3
 *            │    └── c5 feat-5 (#5, main)    edits line 9, next to c1's lines; GitHub lists c1, c5
 *            ├── c4 feat-4 (#4, main)      edits line 15 on an independent branch
 *            └── c10' feat-10 (#10, main)   amended after feat-11 branched from the original c10
 *                 c10 ── c11 feat-11 (#11, feat-10)  GitHub lists the stale copy c10 and c11
 */
let repo: FixtureRepo;
let git: Git;
let source: FakeSource;
const sha: Record<string, string> = {};

const PRS: FakePullRequest[] = [
  { number: 1, head: "feat-1", base: "main" },
  { number: 2, head: "feat-2", base: "feat-1" },
  { number: 3, head: "feat-3", base: "main" },
  { number: 4, head: "feat-4", base: "main" },
  { number: 5, head: "feat-5", base: "main" },
  { number: 10, head: "feat-10", base: "main" },
  { number: 11, head: "feat-11", base: "feat-10" },
];

const withFunction = { 5: "get_case_coverage <- function(data) {", 6: "  nrow(data)", 7: "}" };

beforeAll(async () => {
  repo = await FixtureRepo.create();
  sha.c0 = await repo.commit("c0: initial", { "R/clean.R": numberedFile(30), "README.md": "fixture\n" });
  await repo.checkout("feat-1", "main");
  sha.c1 = await repo.commit("c1: add coverage", { "R/clean.R": numberedFile(30, withFunction), "R/ingest.R": "ingest <- 1\n" });
  await repo.checkout("feat-2", "feat-1");
  sha.c2 = await repo.commit("c2: count distinct cases", {
    "R/clean.R": numberedFile(30, { ...withFunction, 6: "  dplyr::n_distinct(data$case_id)" }),
  });
  await repo.checkout("feat-3", "feat-2");
  await repo.commit("c3: tidy", { "R/clean.R": numberedFile(30, { ...withFunction, 6: "  dplyr::n_distinct(data$case_id)", 25: "changed 25" }) });
  sha.c3 = await repo.rename("R/ingest.R", "R/ingest_oscn.R", "c3b: rename ingest");
  await repo.checkout("feat-5", "feat-1");
  sha.c5 = await repo.commit("c5: comment", { "R/clean.R": numberedFile(30, { ...withFunction, 9: "# helper" }) });
  await repo.checkout("feat-4", "main");
  sha.c4 = await repo.commit("c4: parallel", { "R/clean.R": numberedFile(30, { 15: "changed 15" }) });
  await repo.checkout("feat-10", "main");
  sha.c10old = await repo.commit("c10: guide", { "docs/guide.md": "guide\n" });
  await repo.checkout("feat-11", "feat-10");
  sha.c11 = await repo.commit("c11: extend guide", { "docs/guide.md": "guide\nmore\n" });
  await repo.checkout("feat-10");
  await repo.git("commit", "-q", "--amend", "-m", "c10: guide (amended)");
  sha.c10 = await repo.git("rev-parse", "HEAD");
  await repo.checkout("main");

  git = await Git.open(repo.root);
  source = new FakeSource(repo, PRS);
});

afterAll(async () => {
  await repo.dispose();
});

function load(request: SelectionRequest): Promise<TrailModel> {
  return loadTrail({ git, source, request, fetch: false });
}

function owners(model: TrailModel, path: string): Record<string, number | null> {
  const history = model.histories.find((h) => h.path === path);
  return Object.fromEntries((history?.changes ?? []).map((change) => [change.oid, change.pr]));
}

describe("commit attribution", () => {
  test("assigns inherited commits in stacked PRs to the PR that introduced them", async () => {
    const model = await load({ kind: "explicit", numbers: [1, 2, 3, 4, 5] });
    // #3 lists c1 and c2 because it targets main; #5 lists c1 for the same reason.
    expect(model.prs.get(3)!.commits).toContain(sha.c1!);
    expect(owners(model, "R/clean.R")).toEqual({
      [sha.c1!]: 1,
      [sha.c2!]: 2,
      [await repo.git("rev-parse", "feat-3~1")]: 3,
      [sha.c4!]: 4,
      [sha.c5!]: 5,
    });
  });

  test("omits commits from unselected predecessors instead of crediting the selected PR", async () => {
    const model = await load({ kind: "explicit", numbers: [3] });
    const clean = model.histories.find((h) => h.path === "R/clean.R")!;
    expect(clean.changes.map((change) => change.oid)).toEqual([await repo.git("rev-parse", "feat-3~1")]);
  });

  test("hides a stale copy left by a rebase and reports the stale branch", async () => {
    const model = await load({ kind: "explicit", numbers: [10, 11] });
    expect(model.attributions.get(sha.c10old!)?.copyOf).toEqual({ oid: sha.c10!, pr: 10 });
    const guide = model.histories.find((h) => h.path === "docs/guide.md")!;
    // c10' and c11 are on diverged branches, so Git defines no order between them.
    expect(new Map(guide.changes.map((change) => [change.oid, change.pr]))).toEqual(
      new Map([
        [sha.c10!, 10],
        [sha.c11!, 11],
      ]),
    );
    expect(model.stale.map((notice) => [notice.pr, notice.base])).toEqual([[11, 10]]);
  });
});

describe("file histories", () => {
  test("joins a renamed file's old and new paths into one history", async () => {
    const model = await load({ kind: "explicit", numbers: [1, 3] });
    const ingest = model.histories.find((h) => h.paths.includes("R/ingest.R"))!;
    expect(ingest.path).toBe("R/ingest_oscn.R");
    expect(ingest.changes.map((change) => [change.status, change.pr])).toEqual([
      ["A", 1],
      ["R", 3],
    ]);
    expect(model.histories.some((h) => h.path === "R/ingest.R")).toBe(false);
  });
});

describe("PR selection", () => {
  test("reports a PR number that does not exist and loads the rest", async () => {
    const model = await load({ kind: "explicit", numbers: [1, 99] });
    expect(model.selected).toEqual([1]);
    expect(model.skipped).toEqual([{ number: 99, reason: "no pull request with this number" }]);
  });

  test("selects the current branch's stack without unrelated open PRs", async () => {
    await repo.checkout("feat-2");
    try {
      const model = await load({ kind: "auto" });
      // #1 is feat-2's base, #3 descends from feat-2. #4, #5, #10, and #11 are on other branches.
      expect(model.selected).toEqual([1, 2, 3]);
    } finally {
      await repo.checkout("main");
    }
  });

  test("related mode adds the open PRs that change the focus PR's files", async () => {
    const model = await load({ kind: "related", focus: 2 });
    expect(model.selected).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("focus comparison", () => {
  test("classifies each other change by order and by the focus PR's lines it touches", async () => {
    const model = await load({ kind: "related", focus: 1 });
    const comparisons = await compareFocus(model, new ChangeAnalyzer(git, model), 1);
    const clean = comparisons.find((c) => c.history.path === "R/clean.R")!;
    const byPr = Object.fromEntries(clean.others.map((other) => [other.change.pr, [other.relation, other.finding]]));
    expect(byPr).toEqual({
      2: ["later", "Potentially superseded change"],
      3: ["later", "File overlap"],
      4: ["parallel", "File overlap"],
      5: ["later", "Code overlap"],
    });
    expect(clean.status).toBe("Inspect later changes");
  });

  test("the report names the superseding PR and the review note", async () => {
    const model = await load({ kind: "explicit", numbers: [1, 2], focus: 1 });
    const report = await focusReport(model, new ChangeAnalyzer(git, model), 1, { maxDiffLines: 20, date: new Date("2026-01-01") });
    expect(report).toContain("| `R/clean.R` | #2 | 1 commit | Potentially superseded (#2) | Inspect later changes |");
    expect(report).toContain("+  dplyr::n_distinct(data$case_id)");
    expect(report).toContain("**Review note:** PR #2 replaces lines that PR #1 introduced.");
    expect(report).toContain("| `R/ingest.R` | None | 0 commits | None | No overlap |");
  });
});
