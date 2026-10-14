/** Returns the tuicr command that reviews one GitHub pull request. */
export function tuicrCommandForPullRequest(pr: number): string[] {
  return ["tuicr", "pr", String(pr)];
}

/**
 * Returns the tuicr command that reviews the commits from `parent` (exclusive) to `last` (inclusive),
 * limited to one file. A root commit has no parent, so tuicr receives the single commit.
 */
export function tuicrCommandForCommit(parent: string | null, last: string, path: string): string[] {
  const revisions = parent ? `${parent}..${last}` : last;
  return ["tuicr", "-r", revisions, "-p", path];
}
