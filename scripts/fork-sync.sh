#!/usr/bin/env bash
# Personal-fork sync helper — see docs/fork-maintenance.md (Rule 4: sync
# often, in small increments, before starting new fork-only work).
#
# Sets up the `upstream` remote (got-feedback/feedBack) if it's missing,
# fetches it, reports how far the current branch has drifted, and — unless
# --report-only is passed — merges upstream/main in.
set -euo pipefail

UPSTREAM_URL="https://github.com/got-feedback/feedBack.git"
REPORT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --report-only) REPORT_ONLY=1 ;;
    *)
      echo "Usage: $0 [--report-only]" >&2
      exit 1
      ;;
  esac
done

if upstream_url=$(git remote get-url upstream 2>/dev/null); then
  if [ "$upstream_url" != "$UPSTREAM_URL" ]; then
    echo "Refusing to sync: 'upstream' remote does not point to the canonical" \
         "$UPSTREAM_URL. Fix or remove the existing remote and re-run." >&2
    exit 1
  fi
else
  echo "No 'upstream' remote found — adding $UPSTREAM_URL"
  git remote add upstream "$UPSTREAM_URL"
fi

echo "Fetching upstream/main..."
git fetch upstream main:refs/remotes/upstream/main

behind=$(git rev-list --count HEAD..upstream/main)
ahead=$(git rev-list --count upstream/main..HEAD)

echo "This branch is $ahead commit(s) ahead and $behind commit(s) behind upstream/main."

if [ "$behind" -eq 0 ]; then
  echo "Already up to date with upstream/main."
  exit 0
fi

if [ "$REPORT_ONLY" -eq 1 ]; then
  echo "--report-only passed — not merging. Run without it to merge upstream/main in."
  exit 0
fi

if [ "$behind" -gt 50 ]; then
  echo "Warning: $behind commits behind. Consider syncing more often (Rule 4) —" \
       "this merge may involve more conflict resolution than usual." >&2
fi

echo "Merging upstream/main..."
git merge upstream/main -m "sync: merge upstream/main ($behind commit(s))"
