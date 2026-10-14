export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  stdin?: string | Uint8Array;
  env?: Record<string, string>;
}

export class CommandError extends Error {
  constructor(
    readonly command: string[],
    readonly result: RunResult,
  ) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(`${command.join(" ")} exited with status ${result.exitCode}${detail ? `: ${detail}` : ""}`);
  }
}

/** Runs a command and returns its output without throwing on a nonzero exit status. */
export async function run(command: string[], options: RunOptions = {}): Promise<RunResult> {
  let child;
  try {
    child = Bun.spawn(command, {
      cwd: options.cwd,
      stdin: options.stdin === undefined ? "ignore" : typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
      stdout: "pipe",
      stderr: "pipe",
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `${command[0]} could not start: ${message}`, exitCode: 127 };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Runs a command and throws `CommandError` when it exits with a nonzero status. */
export async function runChecked(command: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(command, options);
  if (result.exitCode !== 0) throw new CommandError(command, result);
  return result.stdout;
}

export function commandExists(name: string): boolean {
  return Bun.which(name) !== null;
}
