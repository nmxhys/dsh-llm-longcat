#!/usr/bin/env bash
# Publish this bundle to GitHub and make it discoverable.
#
# `dsh-plugin` is the topic the DeepSeek Harness CONTRIBUTING file names as the
# way plugins get found, so tagging the repo IS the distribution step — there
# is no registry to submit to and no upstream PR to open.
#
# Usage:  ./publish.sh [github-username]
#
# Safe to re-run: every step is skipped if it is already done.

set -euo pipefail

cd "$(dirname "$0")"

REPO_NAME="dsh-longcat"
USER="${1:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is not installed.  brew install gh" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Not signed in to GitHub.  Run: gh auth login" >&2
  exit 1
fi

if [ -z "$USER" ]; then
  USER=$(gh api user --jq .login)
fi
echo "publishing as ${USER}"

# 1. Tests must pass before anything becomes public.
echo "==> running tests"
npm test

# 2. Create the repo (or reuse an existing one) and push.
if gh repo view "${USER}/${REPO_NAME}" >/dev/null 2>&1; then
  echo "==> repo ${USER}/${REPO_NAME} already exists"
  git remote get-url origin >/dev/null 2>&1 \
    || git remote add origin "https://github.com/${USER}/${REPO_NAME}.git"
  git push -u origin HEAD
else
  echo "==> creating ${USER}/${REPO_NAME}"
  gh repo create "${REPO_NAME}" --public --source=. --push \
    --description "LongCat (LongCat-2.0) provider for DeepSeek Harness — 1M context, thinking mode, tool calling"
fi

# 3. The discovery mechanism. Without `dsh-plugin` nobody finds this.
echo "==> tagging topics"
gh repo edit "${USER}/${REPO_NAME}" \
  --add-topic dsh-plugin \
  --add-topic deepseek-harness \
  --add-topic longcat \
  --add-topic llm-provider

# 4. The README tells users to install by path; fill in the real one.
if grep -q YOUR_GITHUB_USER README.md docs/*.md 2>/dev/null; then
  echo "==> substituting install path"
  sed -i '' "s/YOUR_GITHUB_USER/${USER}/g" README.md docs/*.md
  SHA=$(git rev-parse HEAD)
  sed -i '' "s/COMMIT_SHA/${SHA}/g" README.md docs/*.md
  git add README.md docs
  git commit -q -m "Point install instructions at the published repository"
  # `gh repo create --push` configures origin, but the already-exists branch
  # above may not have; name the remote and branch explicitly either way.
  git push origin HEAD
fi

cat <<EOF

published:  https://github.com/${USER}/${REPO_NAME}
install:    dsh plugin --profile default add github:${USER}/${REPO_NAME}

Remaining, and worth doing in this order:
  1. LONGCAT_API_KEY=... npm run test:e2e     verify against the real endpoint
  2. submit to community catalogs, e.g. 0xsline/awesome-deepseek-harness
  3. send docs/longcat-docs-deepseek-harness.md to the LongCat docs team
EOF
