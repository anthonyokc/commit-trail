import { run } from "./process.ts";

export type DiffRendererChoice = "auto" | "delta" | "pierre" | "builtin";
export type DiffRenderer = "delta" | "pierre" | "builtin";

export function deltaInstalled(): boolean {
  return Bun.which("delta") !== null;
}

/**
 * Selects the diff renderer.
 * `auto` is the default and selects the bundled @pierre/diffs renderer (`pierre`).
 * `delta` throws an error when delta is not on `PATH`.
 */
export function resolveDiffRenderer(choice: DiffRendererChoice): DiffRenderer {
  if (choice === "auto") return "pierre";
  if (choice !== "delta" || deltaInstalled()) return choice;
  throw new Error("The delta diff renderer (from --diff or the config file) requires delta on PATH. Install it with: brew install git-delta");
}

export interface DeltaOptions {
  /** Omit the file name header and its decoration, for panels that already name the file. */
  omitFileHeader?: boolean;
}

/**
 * Renders a unified diff with delta at a fixed width and returns delta's colored output.
 * delta reads its settings from the Git config of `cwd`, so side-by-side mode and themes apply.
 * Throws an error when delta exits with a nonzero status.
 */
export async function renderWithDelta(patch: string, width: number, cwd: string, options: DeltaOptions = {}): Promise<string> {
  const args = ["delta", "--paging=never", `--width=${Math.max(40, width)}`, "--true-color=always", "--line-fill-method=spaces"];
  if (options.omitFileHeader) args.push("--file-style=omit", "--file-decoration-style=omit");
  const result = await run(args, { cwd, stdin: patch, env: { COLORTERM: "truecolor" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `delta exited with status ${result.exitCode}`);
  return result.stdout;
}
