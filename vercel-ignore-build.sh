#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json → ignoreCommand).  exit 0 = SKIP the build, exit 1 = BUILD.
#
# Goal: a documentation-only change (docs/** or any *.md) does not create a deployment.
#
# Vercel's build checkout usually holds ONLY the newest commit (no history, observed 2026-11-13), so file
# changes often cannot be compared. The rules, safest first:
#
#   PRODUCTION (main)  : skip ONLY with proof — the last successfully deployed commit is available and every
#                        file changed since then is documentation. No proof → BUILD. Code can never be skipped.
#   PREVIEW, with proof: same exact comparison when history is available.
#   PREVIEW, no history: skip when the branch is named docs/… (the author's declaration that the branch is
#                        documentation). Every other branch builds. Skipping a preview is the safe direction:
#                        nothing unreleased gets deployed.
set -u
build() { echo "ignore-build: BUILD — $1"; exit 1; }
skip()  { echo "ignore-build: SKIP — $1"; exit 0; }
docs_only() { local f; f="$(cat)"; [ -n "$f" ] && [ -z "$(printf '%s\n' "$f" | grep -v -E '^docs/|\.md$' || true)" ]; }
have() { git cat-file -e "${1}^{commit}" 2>/dev/null; }

envname="${VERCEL_ENV:-}"
ref="${VERCEL_GIT_COMMIT_REF:-}"
base="${VERCEL_GIT_PREVIOUS_SHA:-}"

# Best effort: bring in a little history through the checkout's own remote, if it has one. Never prints it.
if [ -n "$base" ] && ! have "$base" && git remote | grep -q .; then
  git fetch --quiet --depth=50 "$(git remote | head -1)" "$base" >/dev/null 2>&1 || true
fi

if [ -n "$base" ] && have "$base"; then
  if git diff --name-only "$base" HEAD 2>/dev/null | docs_only; then skip "only documentation changed since ${base:0:7}"; fi
  build "non-documentation files changed since ${base:0:7} (or nothing changed)"
fi

[ "$envname" = "production" ] && build "production, and the previously deployed commit is not available to compare"
case "$ref" in
  docs/*) skip "preview of documentation branch '$ref' (no history in this checkout; skipped by branch name)" ;;
esac
build "no history to compare and '${ref:-unknown}' is not a docs/… branch"
