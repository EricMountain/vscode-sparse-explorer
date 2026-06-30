#!/usr/bin/env bash
# Cut a manual release via PR + auto-merge, then push the version tag to trigger CI packaging.
set -euo pipefail

BUMP=${1:-patch}

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
    echo "Usage: $0 [patch|minor|major]" >&2
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is not clean — commit or stash changes first." >&2
    exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo "Must be on main to cut a release (currently on '$CURRENT_BRANCH')." >&2
    exit 1
fi

git pull --ff-only origin main

npm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
BRANCH="release/v${VERSION}"

git checkout -b "$BRANCH"
git add package.json package-lock.json
git commit -m "chore: release v${VERSION}"
git push -u origin "$BRANCH"

PR_URL=$(gh pr create \
    --title "chore: release v${VERSION}" \
    --body "Bump version to \`v${VERSION}\` for release." \
    --base main \
    --head "$BRANCH")

echo "PR created: $PR_URL"

gh pr merge --auto --squash "$PR_URL"
echo "Auto-merge enabled — waiting for CI and merge..."

while true; do
    STATE=$(gh pr view "$PR_URL" --json state --jq '.state')
    if [[ "$STATE" == "MERGED" ]]; then
        break
    elif [[ "$STATE" == "CLOSED" ]]; then
        echo "PR was closed without merging." >&2
        exit 1
    fi
    echo "  PR state: $STATE — checking again in 20s..."
    sleep 20
done

echo "PR merged. Tagging v${VERSION}..."

git checkout main
git pull --ff-only origin main

ACTUAL=$(node -p "require('./package.json').version")
if [[ "$ACTUAL" != "$VERSION" ]]; then
    echo "Version mismatch after merge: expected $VERSION, got $ACTUAL." >&2
    exit 1
fi

git tag -a "v${VERSION}" -m "Release v${VERSION}"
git push origin "v${VERSION}"

echo "Done — v${VERSION} tagged and pushed. CI will build and publish the .vsix."
