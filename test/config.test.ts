import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const dir = await mkdtemp(join(tmpdir(), "commit-trail-config-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a missing config file yields an empty config", async () => {
  expect(await loadConfig(join(dir, "missing.toml"))).toEqual({});
});

test("reads the diff renderer", async () => {
  const path = join(dir, "valid.toml");
  await Bun.write(path, '# comment\ndiff = "delta"\n');
  expect(await loadConfig(path)).toEqual({ diff: "delta" });
});

test("rejects an invalid value and an unknown key, naming the file", async () => {
  const invalid = join(dir, "invalid.toml");
  await Bun.write(invalid, 'diff = "less"\n');
  await expect(loadConfig(invalid)).rejects.toThrow(`${invalid}: diff must be "auto", "delta", or "builtin", not "less".`);
  const unknown = join(dir, "unknown.toml");
  await Bun.write(unknown, 'pager = "delta"\n');
  await expect(loadConfig(unknown)).rejects.toThrow(`${unknown}: unknown setting "pager".`);
});
