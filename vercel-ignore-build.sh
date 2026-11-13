#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json → ignoreCommand).  exit 0 = SKIP the build, exit 1 = BUILD.
#
# Skips a deployment ONLY when every file changed since the last successful deployment of this branch is
# documentation (docs/** or any *.md). Anything else — or any doubt at all — builds. So a docs-only branch
# never creates a preview, and a docs-only commit on main does not redeploy production; code can never be
# skipped by accident.
set -u
build() { echo "ignore-build: BUILD — $1"; exit 1; }
skip()  { echo "ignore-build: SKIP — $1"; exit 0; }

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ]; then
  # First deployment of this branch: compare with where it left main.
  git fetch --quiet --depth=200 origin main 2>/dev/null || build "could not fetch main to compare"
  base="$(git merge-base HEAD FETCH_HEAD 2>/dev/null || true)"
  [ -n "$base" ] || build "could not find where this branch left main"
fi
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=200 origin "$base" 2>/dev/null || build "previous deployment commit is not available"
  git cat-file -e "${base}^{commit}" 2>/dev/null || build "previous deployment commit is not available"
fi
changed="$(git diff --name-only "$base" HEAD 2>/dev/null)" || build "could not list changed files"
[ -n "$changed" ] || build "no changed files detected"
other="$(printf '%s\n' "$changed" | grep -v -E '^docs/|\.md$' || true)"
[ -z "$other" ] && skip "only documentation changed since ${base:0:7}"
build "non-documentation files changed"
