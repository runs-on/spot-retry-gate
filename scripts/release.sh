#!/usr/bin/env bash
set -euo pipefail

fail() { echo "Release error: $*" >&2; exit 1; }
mode=${1:-}
[[ "$mode" == resolve || "$mode" == publish ]] || fail "Expected resolve or publish"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_BRANCH:?RELEASE_BRANCH is required}"
pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$RELEASE_TAG" =~ $pattern ]] || fail "Tag must use canonical vMAJOR.MINOR.PATCH format"
major="v${BASH_REMATCH[1]}"
git check-ref-format "refs/heads/$RELEASE_BRANCH" >/dev/null || fail "Invalid branch name"
git check-ref-format --branch "$RELEASE_BRANCH" >/dev/null || fail "Invalid branch name"

# Refresh the full remote view, including deleted branches and tags.
git fetch --quiet --prune --prune-tags origin \
  '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
branch_sha=$(git rev-parse --verify "refs/remotes/origin/$RELEASE_BRANCH^{commit}") || fail "Source branch does not exist"
if [[ "$mode" == resolve ]]; then
  sha=$branch_sha
else
  : "${RELEASE_SHA:?RELEASE_SHA is required}"
  [[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "Expected a full tested commit SHA"
  sha=$(git rev-parse --verify "$RELEASE_SHA^{commit}") || fail "Tested commit is unavailable"
fi

git show-ref --verify --quiet "refs/tags/$RELEASE_TAG" && fail "Version tag already exists"
git show-ref --verify --quiet "refs/tags/$major" && fail "Major tag conflicts with the release branch"
# BigInt comparisons avoid overflow and do not depend on platform sort behavior.
# shellcheck disable=SC2016 # Template interpolation belongs to JavaScript.
git tag --list | node -e '
const fs = require("node:fs");
const pattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const next = process.argv[1].slice(1).split(".").map(BigInt);
for (const tag of fs.readFileSync(0, "utf8").trim().split("\n")) {
  if (!pattern.test(tag)) continue;
  const current = tag.slice(1).split(".").map(BigInt);
  if (current[0] !== next[0]) continue;
  if (current[1] > next[1] || (current[1] === next[1] && current[2] >= next[2])) {
    console.error(`Release error: version must be newer than ${tag}`);
    process.exit(1);
  }
}
' "$RELEASE_TAG"
if git show-ref --verify --quiet "refs/remotes/origin/$major"; then
  git merge-base --is-ancestor "refs/remotes/origin/$major" "$sha" || fail "Major branch cannot fast-forward to the tested commit"
fi

if [[ "$mode" == resolve ]]; then
  printf 'sha=%s\nmajor=%s\n' "$sha" "$major"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'sha=%s\nmajor=%s\n' "$sha" "$major" >> "$GITHUB_OUTPUT"
  fi
  exit 0
fi

git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  -c tag.gpgSign=false tag -a "$RELEASE_TAG" "$sha" -m "Release $RELEASE_TAG"
# No force: a concurrent incompatible branch update or duplicate tag rejects
# the entire transaction, leaving neither ref partially published.
git push --atomic origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG" "$sha:refs/heads/$major"
printf 'Released %s: %s and %s\n' "$sha" "$RELEASE_TAG" "$major"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  # shellcheck disable=SC2016 # Backticks are literal Markdown.
  printf 'Released `%s`\n\n- Tag: `%s`\n- Major branch: `%s`\n' "$sha" "$RELEASE_TAG" "$major" >> "$GITHUB_STEP_SUMMARY"
fi
