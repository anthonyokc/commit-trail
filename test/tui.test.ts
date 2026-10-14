import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ChangeAnalyzer } from "../src/analysis.ts";
import { Git } from "../src/git.ts";
import { loadTrail } from "../src/model.ts";
import { TrailApp } from "../src/tui/app.ts";
import { FakeSource, FixtureRepo, numberedFile } from "./fixture.ts";

let repo: FixtureRepo;

beforeAll(async () => {
  repo = await FixtureRepo.create();
  await repo.commit("initial", { "R/clean.R": numberedFile(12) });
  await repo.checkout("feat-1", "main");
  await repo.commit("add coverage", { "R/clean.R": numberedFile(12, { 6: "  nrow(data)" }) });
  await repo.checkout("feat-2", "feat-1");
  await repo.commit("count distinct cases", { "R/clean.R": numberedFile(12, { 6: "  dplyr::n_distinct(data$case_id)" }) });
  await repo.checkout("main");
});

afterAll(async () => {
  await repo.dispose();
});

test("the interface shows the file timeline and moves between changes", async () => {
  const git = await Git.open(repo.root);
  const source = new FakeSource(repo, [
    { number: 1, head: "feat-1", base: "main" },
    { number: 4, head: "feat-2", base: "main" },
  ]);
  const model = await loadTrail({ git, source, request: { kind: "explicit", numbers: [1, 4], focus: 1 }, fetch: false });
  const launched: string[][] = [];
  const setup = await createTestRenderer({ width: 110, height: 34 });
  const app = new TrailApp(setup.renderer, {
    model,
    git,
    analyzer: new ChangeAnalyzer(git, model),
    reportDir: repo.root,
    maxDiffLines: 20,
    launch: async (command) => {
      launched.push(command);
      return 0;
    },
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
