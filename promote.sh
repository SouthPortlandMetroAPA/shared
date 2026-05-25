#!/usr/bin/env bash
# promote.sh — promote an app's preprod build to production
#
# Usage:
#   Apps/shared/promote.sh <app-folder>
#
# Example:
#   Apps/shared/promote.sh Apps/BreakOut/site
#
# REPO LAYOUT: each APA app keeps its own git repo at <app>/site/.git
# (one repo per Pages site, no monorepo). The smoke-test docs and this
# script live OUTSIDE every app repo — they're in `tools/claude/<app>/`
# and `Apps/shared/` respectively, which are independent repos.
#
# What it does:
#   1. Resolves <app-folder> to an absolute path. Verifies it contains a
#      .git directory (== this app's repo root) AND a preprod/ folder
#      with at least one file.
#   2. Verifies a smoke-test doc exists at
#        $APA_ROOT/tools/claude/<app-lowercase>/SMOKETEST.md
#      The doc must exist as an explicit "I smoke-tested" gate.
#   3. cd into the app's git repo; refuses to run if the working tree is
#      dirty (uncommitted changes outside preprod/).
#   4. Copies every file in preprod/ over the matching file at the repo
#      root. New files in preprod are added. Files that exist at the
#      repo root but NOT in preprod are LEFT ALONE — use `git rm`
#      manually before promoting if you intend to delete.
#   5. Removes preprod/.
#   6. Stages, commits ("promote: <App> preprod -> prod"), pushes.
#
# Safety rails:
#   - Refuses to run with a dirty tree.
#   - Refuses if preprod/ has no files or is missing.
#   - Refuses if matching SMOKETEST.md doesn't exist.
#   - Does NOT run tests — smoke-testing is a human gate before this.
#
# Cross-platform: POSIX bash. Run via Git Bash on Windows.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <app-folder>"
  echo "Example: $0 Apps/BreakOut/site"
  exit 2
fi

# Where the script lives — APA root is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APA_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Resolve the app folder. Accept absolute or relative-to-APA-root paths.
APP_ARG="${1%/}"
if [ -d "$APP_ARG" ]; then
  APP_FOLDER="$(cd "$APP_ARG" && pwd)"
elif [ -d "$APA_ROOT/$APP_ARG" ]; then
  APP_FOLDER="$(cd "$APA_ROOT/$APP_ARG" && pwd)"
else
  echo "ERROR: app folder not found: $APP_ARG"
  exit 1
fi

if [ ! -d "$APP_FOLDER/.git" ]; then
  echo "ERROR: $APP_FOLDER is not the root of a git repo"
  echo "(expected $APP_FOLDER/.git to exist)"
  exit 1
fi

PREPROD_DIR="$APP_FOLDER/preprod"
if [ ! -d "$PREPROD_DIR" ]; then
  echo "ERROR: no preprod folder at $PREPROD_DIR"
  echo "Nothing to promote."
  exit 1
fi

if [ -z "$(find "$PREPROD_DIR" -type f -print -quit)" ]; then
  echo "ERROR: $PREPROD_DIR exists but contains no files"
  exit 1
fi

# Derive app name (lowercased) for the smoke-test path.
# Apps/<App>/site -> <app>
APP_NAME="$(basename "$(dirname "$APP_FOLDER")")"
APP_NAME_LOWER="$(echo "$APP_NAME" | tr '[:upper:]' '[:lower:]')"
SMOKETEST="$APA_ROOT/tools/claude/$APP_NAME_LOWER/SMOKETEST.md"

if [ ! -f "$SMOKETEST" ]; then
  echo "ERROR: required smoke-test doc not found:"
  echo "       $SMOKETEST"
  echo "Create it before promoting (even an empty checklist is fine — it"
  echo "just must exist as an explicit acknowledgement that you smoke-tested)."
  exit 1
fi

cd "$APP_FOLDER"

# Dirty-tree guard: any uncommitted change in the app repo blocks promotion.
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "ERROR: working tree has uncommitted changes in $APP_FOLDER:"
  echo "$DIRTY"
  echo
  echo "Commit or stash before promoting."
  exit 1
fi

echo "Promoting $PREPROD_DIR -> $APP_FOLDER ..."
# Copy each file from preprod up to the app root.
( cd "$PREPROD_DIR" && find . -type f -print0 ) | while IFS= read -r -d '' rel; do
  src="$PREPROD_DIR/$rel"
  dest="$APP_FOLDER/$rel"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "  copied $rel"
done

# Remove the preprod folder entirely.
rm -rf "$PREPROD_DIR"
echo "  removed $PREPROD_DIR"

# Stage + commit + push.
git add -A
if git diff --cached --quiet; then
  echo "No changes to commit (preprod was identical to production)."
  exit 0
fi

COMMIT_MSG="promote: $APP_NAME preprod -> prod"
git commit -m "$COMMIT_MSG"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$CURRENT_BRANCH"

echo
echo "Promoted. Don't forget:"
echo "  1. Poll the deployed version.js until it serves the new version."
echo "  2. Bump apa_core.apps row for $APP_NAME."
echo "(See reference_deploy.md - strict deploy order.)"
