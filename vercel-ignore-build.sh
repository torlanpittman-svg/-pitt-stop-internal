#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json → ignoreCommand).  exit 0 = SKIP the build, exit 1 = BUILD.
#
# Skips a deployment ONLY when the change is documentation (docs/** or any *.md). Any doubt builds.
#
#   1. A branch that has deployed before (always true for main/production): Vercel provides the commit of its
#      last successful deployment. Skip only if EVERY file changed since then is documentation. Exact.
#   2. A branch's FIRST deployment: Vercel's build checkout cannot fetch other branches, so there is nothing
#      exact to compare with. Skip only when BOTH hold:
#        - the branch is named docs/…   (the author's declaration that it is documentation), and
#        - the newest commit is documentation-only against a parent (for a merge of main into the branch,
#          against the merged-in parent — i.e. the branch equals main plus documentation).
#      A code commit hidden under a docs/… branch name is the author's mistake to avoid; every other branch
#      name always builds its first deployment.
set -u
build() { echo "ignore-build: BUILD — $1"; exit 1; }
skip()  { echo "ignore-build: SKIP — $1"; exit 0; }
docs_only() { # stdin: changed file names; succeeds when there is at least one and all are documentation
  local files; files="$(cat)"
  [ -n "$files" ] || return 1
  [ -z "$(printf '%s\n' "$files" | grep -v -E '^docs/|\.md$' || true)" ]
}

base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -n "$base" ]; then
  git cat-file -e "${base}^{commit}" 2>/dev/null || build "the previous deployment's commit is not in this checkout"
  changed="$(git diff --name-only "$base" HEAD 2>/dev/null)" || build "could not list changed files"
  printf '%s\n' "$changed" | docs_only && skip "only documentation changed since ${base:0:7}"
  build "non-documentation files changed since ${base:0:7} (or nothing changed)"
fi

ref="${VERCEL_GIT_COMMIT_REF:-}"
case "$ref" in docs/*) ;; *) build "first deployment of branch '${ref:-unknown}' (only docs/… branches may skip a first deployment)";; esac
parents="$(git rev-list --parents -n 1 HEAD 2>/dev/null | cut -d' ' -f2-)"
[ -n "$parents" ] || build "the newest commit's parent is not in this checkout"
for p in $parents; do
  git cat-file -e "${p}^{commit}" 2>/dev/null || continue
  if git diff --name-only "$p" HEAD 2>/dev/null | docs_only; then skip "docs/… branch whose newest commit is documentation-only against ${p:0:7}"; fi
done
build "docs/… branch, but its newest commit changes non-documentation files"
