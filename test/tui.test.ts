import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ChangeAnalyzer } from "../src/analysis.ts";
import { Git } from "../src/git.ts";
import { loadTrail } from "../src/model.ts";
import { TrailApp, type AppOptions } from "../src/tui/app.ts";
import { FakeSource, FixtureRepo, numberedFile } from "./fixture.ts";

let repo: FixtureRepo;
let secondCommit: string;

beforeAll(async () => {
  repo = await FixtureRepo.create();
  await repo.commit("initial", { "R/clean.R": numberedFile(12) });
  await repo.checkout("feat-1", "main");
  await repo.commit("add coverage", { "R/clean.R": numberedFile(12, { 6: "  nrow(data)" }) });
  await repo.checkout("feat-2", "feat-1");
  secondCommit = await repo.commit("count distinct cases", { "R/clean.R": numberedFile(12, { 6: "  dplyr::n_distinct(data$case_id)" }) });
  await repo.checkout("main");
});

afterAll(async () => {
  await repo.dispose();
});

async function startApp(overrides: Partial<AppOptions> = {}) {
  const git = await Git.open(repo.root);
  const source = new FakeSource(repo, [
    { number: 1, head: "feat-1", base: "main" },
    { number: 4, head: "feat-2", base: "main" },
  ]);
  const model = await loadTrail({ git, source, request: { kind: "explicit", numbers: [1, 4], focus: 1 }, fetch: false });
  const launched: string[][] = [];
  const launchEnv: (Record<string, string> | undefined)[] = [];
  const setup = await createTestRenderer({ width: 110, height: 34 });
  const app = new TrailApp(setup.renderer, {
    model,
    git,
    analyzer: new ChangeAnalyzer(git, model),
    reportDir: repo.root,
    maxDiffLines: 20,
    launch: async (command, env) => {
      launched.push(command);
      launchEnv.push(env);
      return 0;
    },
    ...overrides,
  });
  setup.renderer.keyInput.on("keypress", (key) => app.handleKey(key));

  // Analysis runs git in the background, so poll the frame by time instead of by frame count.
  const frameWith = async (needle: string): Promise<string> => {
    const deadline = Date.now() + 5000;
    while (true) {
      await setup.renderOnce();
      const text = setup.captureCharFrame();
      if (text.includes(needle)) return text;
      if (Date.now() > deadline) throw new Error(`The frame never contained "${needle}":\n${text}`);
      await Bun.sleep(10);
    }
  };
  return { setup, launched, launchEnv, frameWith };
}

test("the interface shows the file timeline and moves between changes", async () => {
  const { setup, launched, frameWith } = await startApp();

  // The focus PR's change is selected first. Its later change comes from PR #4.
  let frame = await frameWith("Later changes:   #4");
  expect(frame).toContain("clean.R");
  expect(frame).toContain("PR #1: PR 1 from feat-1");

  await setup.mockInput.pressKey("l");
  frame = await frameWith("Revises: replaces 1 line(s) from #1");
  expect(frame).toContain("Earlier changes: #1");
  expect(frame).toContain("+  dplyr::n_distinct(data$case_id)");

  await setup.mockInput.pressKey("o");
  await setup.waitFor(() => launched.length === 1);
  expect(launched[0]).toEqual(["tuicr", "pr", "4"]);

  await setup.dispose();
});

test("delta renders the preview and the full diff, t switches renderers, and D opens a pager", async () => {
  const calls: { width: number; omitFileHeader: boolean }[] = [];
  const { setup, launched, launchEnv, frameWith } = await startApp({
    diffRenderer: "delta",
    renderDelta: async (patch, width, options) => {
      calls.push({ width, omitFileHeader: options.omitFileHeader ?? false });
      expect(patch).toContain("diff --git a/R/clean.R b/R/clean.R");
      return options.omitFileHeader ? "\x1b[34mDELTA PREVIEW LINE\x1b[0m\n" : "\x1b[48;2;0;40;0mDELTA FULL LINE\x1b[0m\n";
    },
  });
  await setup.mockInput.pressKey("l");
  let frame = await frameWith("DELTA PREVIEW LINE");
  expect(frame).toContain("Revises:");

  await setup.mockInput.pressEnter();
  frame = await frameWith("DELTA FULL LINE");
  expect(frame).toContain("[delta]");
  // Both panels span the terminal: 110 columns minus borders and padding.
  expect(calls.filter((call) => !call.omitFileHeader).map((call) => call.width)).toEqual([106]);
  expect(calls.some((call) => call.omitFileHeader && call.width === 106)).toBe(true);

  await setup.mockInput.pressKey("D", { shift: true });
  await setup.waitFor(() => launched.length === 1);
  expect(launched[0]).toEqual(["git", "-c", "core.pager=delta --paging=always", "show", secondCommit, "--", "R/clean.R"]);
  expect(launchEnv[0]?.LESS).toEndWith("-+F");

  await setup.mockInput.pressKey("t");
  frame = await frameWith("[built-in]");
  expect(frame).not.toContain("DELTA FULL LINE");
  expect(frame).toContain("+  dplyr::n_distinct(data$case_id)");

  // The preview follows the renderer too.
  await setup.mockInput.pressEscape();
  frame = await frameWith("SELECTED CHANGE");
  expect(frame).not.toContain("DELTA PREVIEW LINE");

  // In built-in mode, D uses Git's configured pager.
  await setup.mockInput.pressKey("D", { shift: true });
  await setup.waitFor(() => launched.length === 2);
  expect(launched[1]).toEqual(["git", "show", secondCommit, "--", "R/clean.R"]);

  await setup.dispose();
});

test("the interface falls back to the built-in renderer when delta fails", async () => {
  const { setup, frameWith } = await startApp({
    diffRenderer: "delta",
    renderDelta: async () => {
      throw new Error("unknown option");
    },
  });
  let frame = await frameWith("delta failed, so the built-in diff is shown: unknown option");
  expect(frame).toContain("+  nrow(data)");
  await setup.mockInput.pressEnter();
  frame = await frameWith("[built-in]");
  expect(frame).toContain("+  nrow(data)");
  await setup.dispose();
});
