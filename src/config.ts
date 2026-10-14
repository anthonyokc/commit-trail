import { homedir } from "node:os";
import { join } from "node:path";
import type { DiffRendererChoice } from "./delta.ts";

/** Settings from the config file. Command-line options override them. */
export interface FileConfig {
  /** Renderer for the full diff view and the `D` key. */
  diff?: DiffRendererChoice;
}

const DIFF_CHOICES: DiffRendererChoice[] = ["auto", "delta", "builtin"];

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "commit-trail", "config.toml");
}

/**
 * Reads a TOML config file.
 * Returns an empty config when the file does not exist.
 * Throws an error that names the file for invalid TOML, an unknown key, or an invalid value.
 */
export async function loadConfig(path: string): Promise<FileConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  let raw: Record<string, unknown>;
  try {
    raw = Bun.TOML.parse(await file.text()) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${path} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const config: FileConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "diff") {
      if (typeof value !== "string" || !DIFF_CHOICES.includes(value as DiffRendererChoice)) {
        throw new Error(`${path}: diff must be "auto", "delta", or "builtin", not ${JSON.stringify(value)}.`);
      }
      config.diff = value as DiffRendererChoice;
    } else {
      throw new Error(`${path}: unknown setting "${key}". The supported setting is: diff.`);
    }
  }
  return config;
}
