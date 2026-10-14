# commit-trail

commit-trail is a terminal application that follows each file's changes across a set of GitHub pull requests. It answers two review questions:

1. How does this file change across the selected PRs?
2. Does a later PR already change code that I might flag while I review an earlier PR?

The file is the main unit of navigation. You select a file, step through the commits that changed it, and read each diff with its PR. commit-trail complements [tuicr](https://github.com/agavra/tuicr): commit-trail shows the history, and tuicr writes and submits review comments.

```text
 commit-trail  owner/repo  Branch: main
 PRs: #1–#12  9 files  Timeline: commits  Focus: #1
┌─ FILES ───────────────────┐┌─ FILE HISTORY ─────────────────────────────────────┐
│ R/process/                ││ R/process/clean_defendants.R  3 changes in 3 PRs   │
│ › clean_defendants.R   3  ││                                                    │
│   clean_bookings.R     2  ││   ◉ #1 ──── ● #4 ──── ● #10                        │
│                           ││                                                    │
│                           ││ ›  1  #1   a83c241  Added     +12 -0  add coverage │
│                           ││    2  #4   b12f9e0  Modified  +1 -1   count cases  │
└───────────────────────────┘└────────────────────────────────────────────────────┘
┌─ SELECTED CHANGE ──────────────────────────────────────────────────────────────┐
│ PR #1: feat(pipeline): add coverage checks  open  @author                      │
│ Commit: a83c241  add coverage                                                  │
│ Later changes:   #4 b12f9e0, #10 c51d0aa                                       │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Requirements

- macOS or Linux (x64 or arm64).
- Git 2.29 or later.
- The [GitHub CLI](https://cli.github.com) (`gh`), signed in with `gh auth login`.
- Optional: [tuicr](https://github.com/agavra/tuicr), for the `o` and `O` keys.
- For a source installation only: [Bun](https://bun.sh) 1.3 or later.

## Installation

### Install with Homebrew

The repository is its own Homebrew tap. The formula is `Formula/commit-trail.rb`.

1. Add the tap:

   ```bash
   brew tap anthonyokc/commit-trail https://github.com/anthonyokc/commit-trail
   ```

2. Install the latest release:

   ```bash
   brew install anthonyokc/commit-trail/commit-trail
   ```

3. Verify the installation:

   ```bash
   commit-trail --version
   ```

To install the newest commit on `main` instead of the latest release, run `brew install --HEAD anthonyokc/commit-trail/commit-trail`.

To upgrade, run `brew update`, then run `brew upgrade commit-trail`.

Homebrew builds commit-trail from source with Bun. It installs Bun as a build dependency and installs `gh` as a runtime dependency.

Note: while the GitHub repository is private, Homebrew must authenticate to GitHub to clone it. Use one of these methods:

- Run `gh auth setup-git`. Git then uses your `gh` credentials for HTTPS clones.
- Tap with the SSH URL: `brew tap anthonyokc/commit-trail git@github.com:anthonyokc/commit-trail.git`. The formula still downloads the source over HTTPS, so the first method is also necessary.

### Install from source

1. Clone the repository and install the dependencies:

   ```bash
   git clone https://github.com/anthonyokc/commit-trail.git
   cd commit-trail
   bun install
   ```

2. Choose one of these options:

   - Link the `commit-trail` command to the source tree. Bun then runs the TypeScript source directly:

     ```bash
     bun link
     ```

   - Build a standalone executable at `dist/commit-trail`, then copy it to a directory on your `PATH`:

     ```bash
     bun run build
     cp dist/commit-trail ~/.local/bin/
     ```

The standalone executable contains the Bun runtime and the OpenTUI native library. It does not require Bun at run time.

## Usage

Run commit-trail inside a clone of a GitHub repository.

### Select pull requests

| Command | Selected PRs |
|---|---|
| `commit-trail` | The open PR of the current branch, plus the PRs stacked with it |
| `commit-trail 1` | PR #1, plus every open PR that changes one of PR #1's files |
| `commit-trail 1:12` or `commit-trail 1-12` | PRs #1 through #12, inclusive |
| `commit-trail 1 2 3 8 10` | Exactly these PRs. Commas also separate numbers: `1,2,3` |

With no arguments, commit-trail finds the open PR whose head branch is the current branch. It adds PRs that target that branch or that the branch targets, and PRs whose head commits are ancestors or descendants of it. It does not add unrelated open PRs. If no open PR uses the current branch, commit-trail stops and asks for PR numbers.

If a number in a range has no pull request, commit-trail reports that it skipped the number and loads the others.

With one PR number, commit-trail runs in focus mode. The file list shows only the focus PR's files. Press `a` to show the files of every loaded PR.

### Keys

| Key | Action |
|---|---|
| `j` / `k` | Select the next or previous file |
| `h` / `l` | Move backward or forward through the selected file's changes |
| `Enter` | Show the full diff of the selected change |
| `Esc` | Return to the file history, or clear the search |
| `p` | Switch between the commit timeline and the PR timeline |
| `a` | In focus mode, switch between the focus PR's files and all files |
| `o` | Open the selected change's PR in tuicr (`tuicr pr <number>`) |
| `O` | Open the selected commit in tuicr, limited to the file |
| `/` | Search file paths |
| `r` | Write a Markdown report for the selected change's PR |
| `R` | Write a Markdown report for all loaded PRs |
| `y` | Copy the last report to the clipboard. If no report exists, commit-trail first creates one for the selected PR |
| `?` | Show the key list and the load notes (skipped PRs, stale branches, warnings) |
| `q` | Quit |

The timeline contains only the commits that change the selected file. If a file appears in 30 commits and 4 of them change it, the timeline has 4 nodes. The PR timeline (`p`) combines each PR's commits into one node and shows the combined diff.

Changes on separate branches appear in separate lanes. Git defines no order between lanes, so the "Parallel" line lists those changes separately from earlier and later changes.

The `r` and `R` keys write reports to the system temporary directory, in `commit-trail/`. To use a different directory, start commit-trail with `--report-dir <path>`.

### Generate a report without the interface

| Command | Report |
|---|---|
| `commit-trail report 1` | PR #1, compared with every open PR that changes one of its files |
| `commit-trail report 1 --against 1:12` | PR #1, compared with PRs #1 through #12 |
| `commit-trail report 1:12` | The file histories of PRs #1 through #12 |

The report goes to standard output. To write a file, add `-o report.md`. To copy the report to the clipboard, add `--copy`. The clipboard copy uses `pbcopy`, `wl-copy`, `xclip`, `xsel`, or `clip.exe` (WSL).

A focus report has a summary table and one section for each file of the focus PR. Each section shows the focus PR's diff and then each other PR's change to the file, with one finding:

| Finding | Meaning |
|---|---|
| File overlap | Another PR modifies the file, but not lines next to the focus PR's lines. |
| Code overlap | Another PR edits lines next to the focus PR's lines, or the focus PR edits lines from an earlier PR. |
| Potentially superseded change | A later PR removes or replaces lines that the focus PR introduced. |

A report never claims that a later change resolves a review concern. It shows the evidence for that decision.

### Options

| Option | Effect |
|---|---|
| `-C`, `--repo <path>` | Use the repository at `<path>` instead of the current directory |
| `--remote <name>` | Fetch PR commits from this Git remote. The default is the remote whose URL names the GitHub repository |
| `--no-fetch` | Do not run `git fetch`. PRs whose head commits are missing locally are skipped |
| `--offline` | Read GitHub metadata from the cache only. Implies `--no-fetch` |
| `--refresh` | Ignore cached PR commit lists and read them from GitHub again |
| `--cache-dir <path>` | Store the cache in `<path>`. The default is `$XDG_CACHE_HOME/commit-trail`, or `~/.cache/commit-trail` |
| `-o`, `--output <file>` | `report` only: write the Markdown report to `<file>` |
| `--copy` | `report` only: copy the Markdown report to the clipboard |
| `--max-diff-lines <n>` | Show at most `n` diff lines for each patch in a report. The default is 60 |
| `--report-dir <path>` | Write reports from the `r` and `R` keys to `<path>` |

## How commit-trail builds the history

commit-trail reads PR metadata and commit lists from GitHub through `gh`. It reads ancestry, changed files, renames, patches, and blame from the local Git repository. It never checks out a PR branch.

### What commit-trail changes

commit-trail does not change your branches, your working tree, or GitHub. It writes in two places:

- If a PR's head commit is missing locally, commit-trail runs `git fetch --no-write-fetch-head <remote> pull/<number>/head`. This command adds commit objects to the repository. It does not create or move any branch or ref. Use `--no-fetch` to prevent it.
- commit-trail stores GitHub metadata in its cache directory. The cache indexes each PR's commit list by the PR's head commit SHA. When a PR branch changes, its head SHA changes, and commit-trail reads the new commit list from GitHub.

### Assign commits to the PR that introduced them

GitHub lists inherited commits in stacked PRs. If PR #10 targets `main` but its branch starts from PR #9's branch, GitHub lists the commits of PRs #1 through #9 in PR #10. commit-trail removes those inherited commits from PR #10:

1. PR `q` is a predecessor of PR `p` if `q`'s head commit is an ancestor of `p`'s head commit, or if `p` targets `q`'s head branch.
2. Each commit has candidates: the PRs that list it, plus predecessors whose branches contain it.
3. A candidate with a predecessor among the other candidates did not introduce the commit. commit-trail removes it.
4. If one candidate remains, it owns the commit. If several remain, the commit is ambiguous. The interface marks an ambiguous owner as `#4?/#7?`.

commit-trail loads every open PR's head commit for this step, so attribution works even when you select only some PRs of a stack. Commits that belong to an unselected PR do not appear.

A rebase can leave old copies of a predecessor's commits in a stacked branch. commit-trail compares patch IDs (`git patch-id --stable`). If a commit repeats the patch of a commit in a predecessor PR, commit-trail hides the copy and reports the stale branch. If two unrelated PRs contain the same patch, as after a cherry-pick, the interface lists the other commit under "Same patch also in".

### Classify overlap

For each change, commit-trail runs `git blame` on the commit's first parent for the lines in each diff hunk. A removed line from an earlier commit counts as replaced. An unchanged context line from an earlier commit counts as adjacent. The finding for a later change then follows from the focus PR's lines that it touches.

A change is later than the focus PR's change if one of the focus PR's commits for the file is its ancestor. It is earlier if it is an ancestor of one of those commits. Otherwise it is parallel.

### Rename tracking

Git's rename detection (`-M`) links a file's old and new paths. commit-trail shows the history under the newest path and lists the other paths.

## Limitations

- GitHub returns at most 250 commits for one PR. Commits after the first 250 do not appear.
- commit-trail loads at most 500 open PRs as attribution context.
- Merge commits do not appear in file histories. The load notes report how many merge commits commit-trail skipped.
- A rebase that changes a patch (for example, a conflict resolution) produces a new patch ID. commit-trail then treats the old copy as a separate change.
- Rename tracking joins histories by path. If a path is deleted and later reused for a different file, both files share one history.
- The "Hunk context" text comes from Git's function-name detection. For some languages it shows the nearest line that starts with a letter, not a function name.

## Development

```bash
bun install
bun test            # unit and integration tests; the tests create temporary Git repositories
bun run typecheck   # TypeScript type check
bun run start -- 1  # run from source, with arguments after --
```

### Release a new version for Homebrew

1. Update `version` in `package.json`.
2. Update the `tag` and `version` values in `Formula/commit-trail.rb`.
3. Commit the changes, then create and push the tag:

   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```

4. Test the formula:

   ```bash
   brew update
   brew reinstall anthonyokc/commit-trail/commit-trail
   brew test commit-trail
   ```
