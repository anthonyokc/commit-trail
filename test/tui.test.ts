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

async function startApp(overrides: Partial<AppOptions> = {}, fixture: FixtureRepo = repo) {
  const git = await Git.open(fixture.root);
  const source = new FakeSource(fixture, [
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
    reportDir: fixture.root,
    maxDiffLines: 20,
    // The built-in renderer keeps these tests independent of syntax themes. Tests that need another renderer override it.
    diffRenderer: "builtin",
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

test("rapid file moves render only the file that stays selected", async () => {
  const three = await FixtureRepo.create();
  await three.commit("initial", { "a.txt": numberedFile(12), "b.txt": numberedFile(12), "c.txt": numberedFile(12) });
  await three.checkout("feat-1", "main");
  await three.commit("change all", { "a.txt": numberedFile(12, { 6: "a" }), "b.txt": numberedFile(12, { 6: "b" }), "c.txt": numberedFile(12, { 6: "c" }) });
  await three.checkout("feat-2", "feat-1");
  await three.checkout("main");
  const rendered: string[] = [];
  const renderPierre: AppOptions["renderPierre"] = async (patch) => {
    const path = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? "?";
    rendered.push(path);
    return { lines: [[{ text: `RENDERED ${path}` }]], gapRows: [], actions: [] };
  };
  const { setup, frameWith } = await startApp({ diffRenderer: "pierre", renderPierre }, three);
  try {
    await frameWith("RENDERED a.txt");
    // A held key passes over b.txt.
    await setup.mockInput.pressKey("j");
    await setup.mockInput.pressKey("j");
    await frameWith("RENDERED c.txt");
    expect(rendered).not.toContain("b.txt");

    // After the selection settles, moving back loads the passed-over file.
    await Bun.sleep(200);
    await setup.mockInput.pressKey("k");
    await frameWith("RENDERED b.txt");
  } finally {
    await setup.dispose();
    await three.dispose();
  }
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
    renderPierre: async () => ({ lines: [[{ text: "PIERRE RENDERED LINE" }]], gapRows: [], actions: [] }),
  });
  await setup.mockInput.pressKey("l");
  let frame = await frameWith("DELTA PREVIEW LINE");
  expect(frame).toContain("Revises:");

  await setup.mockInput.pressEnter();
  frame = await frameWith("DELTA FULL LINE");
  expect(frame).toContain("[delta");
  // Both panels span the terminal: 110 columns minus borders and padding.
  expect(calls.filter((call) => !call.omitFileHeader).map((call) => call.width)).toEqual([106]);
  expect(calls.some((call) => call.omitFileHeader && call.width === 106)).toBe(true);

  await setup.mockInput.pressKey("D", { shift: true });
  await setup.waitFor(() => launched.length === 1);
  expect(launched[0]).toEqual(["git", "-c", "core.pager=delta --paging=always", "show", secondCommit, "--", "R/clean.R"]);
  expect(launchEnv[0]?.LESS).toEndWith("-+F");

  // t cycles pierre, delta, built-in.
  await setup.mockInput.pressKey("t");
  frame = await frameWith("[built-in");
  await setup.mockInput.pressKey("t");
  frame = await frameWith("PIERRE RENDERED LINE");
  expect(frame).toContain("[pierre");
  await setup.mockInput.pressKey("t");
  frame = await frameWith("DELTA FULL LINE");

  await setup.mockInput.pressKey("t");
  frame = await frameWith("[built-in");
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
  await frameWith("delta failed, so the built-in diff is shown: unknown option");
  await frameWith("+  nrow(data)");
  await setup.mockInput.pressEnter();
  const frame = await frameWith("[built-in");
  expect(frame).toContain("+  nrow(data)");
  await setup.dispose();
});

test("the pierre diff view reveals hidden lines with a click on Show, E, and e", async () => {
  const { setup, frameWith } = await startApp({ diffRenderer: "pierre", contextLines: 1 });
  await frameWith("Later changes:   #4");
  await setup.mockInput.pressEnter();

  // The change is on line 6 of a 12-line file. One context line shows lines 5-7 and hides 1-4 and 8-12.
  let frame = await frameWith("⋯ 4 hidden lines   Show 4 lines");
  expect(frame).toContain("[pierre · 1 context line]");
  expect(frame).toContain("⋯ 5 hidden lines   Show 5 lines");
  expect(frame).not.toContain("@@");

  const rows = frame.split("\n");
  const row = rows.findIndex((line) => line.includes("⋯ 4 hidden lines"));
  await setup.mockMouse.click(rows[row]!.indexOf("Show 4 lines") + 2, row);
  frame = await frameWith("[pierre · 1 context line, expanded]");
  expect(frame).not.toContain("⋯ 4 hidden lines");
  expect(frame).toContain("⋯ 5 hidden lines");
  expect(frame).toContain(" 1  1   line 1");

  await setup.mockInput.pressKey("E", { shift: true });
  frame = await frameWith("[pierre · whole file]");
  expect(frame).not.toContain("⋯");
  await setup.mockInput.pressKey("E", { shift: true });
  frame = await frameWith("[pierre · 1 context line, expanded]");
  await setup.mockInput.pressKey("e");
  frame = await frameWith("Showing 10 more lines");
  expect(frame).not.toContain("⋯");
  await setup.dispose();
});

test("the preview reveals hidden lines on click, expands with E, and scrolls with J and K", async () => {
  const { setup, frameWith } = await startApp({ diffRenderer: "pierre", previewContextLines: 2 });
  // Two context lines show lines 4-8 and hide 1-3 and 9-12.
  let frame = await frameWith("⋯ 3 hidden lines   Show 3 lines");
  const rows = frame.split("\n");
  const row = rows.findIndex((line) => line.includes("⋯ 3 hidden lines"));
  await setup.mockMouse.click(rows[row]!.indexOf("Show 3 lines") + 2, row);
  frame = await frameWith(" 1  1   line 1");
  expect(frame).not.toContain("⋯ 3 hidden lines");
  // The click revealed lines in the preview without opening the full diff view.
  expect(frame).toContain("SELECTED CHANGE");

  await setup.mockInput.pressKey("E", { shift: true });
  frame = await frameWith("lines below · scroll or J");
  await setup.mockInput.pressKey("J", { shift: true });
  frame = await frameWith("↑ 3 lines above · scroll or K");
  await setup.mockInput.pressKey("K", { shift: true });
  frame = await frameWith("lines below · scroll or J");
  expect(frame).not.toContain("lines above");
  await setup.dispose();
});

test("a click on a commit in Later changes selects that change, and a click elsewhere opens the diff", async () => {
  const { setup, frameWith } = await startApp();
  let frame = await frameWith("Later changes:   #4");
  expect(frame).toContain("PR #1: PR 1 from feat-1");

  const lines = frame.split("\n");
  const row = lines.findIndex((line) => line.includes("Later changes:   #4"));
  await setup.mockMouse.click(lines[row]!.indexOf("#4") + 1, row);
  frame = await frameWith("PR #4: PR 4 from feat-2");
  expect(frame).toContain("Earlier changes: #1");

  // The first row of the panel is not a commit label.
  const titleRow = frame.split("\n").findIndex((line) => line.includes("PR #4: PR 4 from feat-2"));
  await setup.mockMouse.click(5, titleRow);
  await frameWith("DIFF #4 R/clean.R");
  await setup.dispose();
});

test("two files changed by one commit each show their own diff", async () => {
  const two = await FixtureRepo.create();
  await two.commit("initial", { "a.txt": numberedFile(12), "b.txt": numberedFile(12) });
  await two.checkout("feat-1", "main");
  await two.commit("change both", { "a.txt": numberedFile(12, { 6: "alpha change" }), "b.txt": numberedFile(12, { 6: "beta change" }) });
  await two.checkout("feat-2", "feat-1");
  await two.commit("change a again", { "a.txt": numberedFile(12, { 6: "alpha again" }) });
  await two.checkout("main");
  const { setup, frameWith } = await startApp({ diffRenderer: "pierre" }, two);
  await frameWith("alpha change");
  await setup.mockInput.pressKey("j");
  let frame = await frameWith("beta change");
  expect(frame).not.toContain("alpha change");
  await setup.mockInput.pressEnter();
  frame = await frameWith("DIFF #1 b.txt");
  frame = await frameWith("beta change");
  expect(frame).toContain("[pierre");
  expect(frame).not.toContain("alpha");
  await setup.dispose();
  await two.dispose();
});
