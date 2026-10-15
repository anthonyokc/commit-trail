#!/usr/bin/env bash
# Records docs/demo.gif: commit-trail on two open PRs of agavra/tuicr
# (#778 and #780) that change the same diff view files.
#
# Requires tmux, gh, asciinema 3, and agg. With Nix:
#   nix shell nixpkgs#asciinema nixpkgs#asciinema-agg -c scripts/record-demo.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${DEMO_WORKDIR:-${TMPDIR:-/tmp}/commit-trail-demo}"
repo="$work/tuicr"
cast="$work/demo.cast"
out="$root/docs/demo.gif"
session=commit-trail-demo
prs="${DEMO_PRS:-778 780}"

mkdir -p "$work" "$root/docs"
[[ -d $repo ]] || gh repo clone agavra/tuicr "$repo" -- --quiet

# Warm the cache and fetch the PR heads so the recording does not wait on the network.
"$root/bin/commit-trail" report -C "$repo" $prs >/dev/null

rm -f "$cast"
tmux kill-session -t "$session" 2>/dev/null || true
# The recording runs commit-trail directly, so it ends when the app quits. Echo is
# off so keys sent during startup do not land on the restored screen.
cat >"$work/run.sh" <<EOF
#!/usr/bin/env bash
stty -echo
sleep 1
printf '\$ '
for word in commit-trail $prs; do
  for ((i = 0; i < \${#word}; i++)); do printf '%s' "\${word:i:1}"; sleep 0.05; done
  printf ' '; sleep 0.1
done
sleep 0.5; printf '\n'
exec "$root/bin/commit-trail" $prs
EOF
chmod +x "$work/run.sh"
tmux new-session -d -s "$session" -x 120 -y 36 -c "$repo" \
  "asciinema rec --quiet --overwrite --window-size 120x36 -c '$work/run.sh' '$cast'"

keys() { tmux send-keys -t "$session" "$@"; }
pause() { sleep "$1"; }
screen() { tmux capture-pane -p -t "$session"; }
# Waits until the pane shows $1 and no longer shows "Reading diff", up to 60 s.
settle() {
  for _ in $(seq 300); do
    if screen | grep -qF -- "$1" && ! screen | grep -qF "Reading diff"; then return; fi
    sleep 0.2
  done
  echo "timed out waiting for: $1" >&2
  screen >&2
  exit 1
}

settle "SELECTED CHANGE"; pause 2
keys j; settle "diff_side_by_side.rs  2 changes"; pause 2.5   # changed by both PRs
keys l; settle "PR #780:"; pause 2.5                           # the parallel change
keys h; settle "PR #778:"; pause 1.5
keys Enter; pause 3.5                                         # full diff
keys Escape; settle "SELECTED CHANGE"; pause 1
keys j; settle "diff_unified.rs  2 changes"; pause 2.5
keys l; settle "PR #780:"; pause 2
keys p; settle "Timeline: pull requests"; pause 3             # one node per PR
keys q

while tmux has-session -t "$session" 2>/dev/null; do sleep 0.2; done

agg --idle-time-limit 2 --font-size 14 --theme monokai "$cast" "$out"
echo "wrote $out"
