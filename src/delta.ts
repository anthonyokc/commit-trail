import { run } from "./process.ts";

export type DiffRendererChoice = "auto" | "delta" | "builtin";
export type DiffRenderer = "delta" | "builtin";

export function deltaInstalled(): boolean {
  return Bun.which("delta") !== null;
}

/**
 * Selects the renderer for the full diff view.
 * `auto` selects delta when it is on `PATH`, and the built-in renderer otherwise.
 * `delta` throws an error when delta is not on `PATH`.
 */
export function resolveDiffRenderer(choice: DiffRendererChoice): DiffRenderer {
  if (choice === "builtin") return "builtin";
  if (deltaInstalled()) return "delta";
  if (choice === "delta") throw new Error("The delta diff renderer (from --diff or the config file) requires delta on PATH. Install it with: brew install git-delta");
  return "builtin";
}

/**
 * Renders a unified diff with delta at a fixed width and returns delta's colored output.
 * delta reads its settings from the Git config of `cwd`, so side-by-side mode and themes apply.
 * Throws an error when delta exits with a nonzero status.
 */
export async function renderWithDelta(patch: string, width: number, cwd: string): Promise<string> {
  const result = await run(
    ["delta", "--paging=never", `--width=${Math.max(40, width)}`, "--true-color=always", "--line-fill-method=spaces"],
    { cwd, stdin: patch, env: { COLORTERM: "truecolor" } },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `delta exited with status ${result.exitCode}`);
  return result.stdout;
}
