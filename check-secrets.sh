#!/usr/bin/env bash
# Quick secret-exposure check before git push.
# Run from the repo root (git bash on Windows works fine):
#   bash check-secrets.sh

set -uo pipefail

echo "== 1. .gitignore coverage for common secret files =="
for pattern in ".env" "*.pem" "*.key" "secrets" "credentials"; do
  if grep -q -- "$pattern" .gitignore 2>/dev/null; then
    echo "  [ok] $pattern is in .gitignore"
  else
    echo "  [!!] $pattern NOT in .gitignore"
  fi
done

echo ""
echo "== 2. Tracked files that look like secrets =="
HITS=$(git ls-files | grep -iE '\.env($|\.)|secret|credential|\.pem$|\.key$|id_rsa' || true)
if [ -n "$HITS" ]; then
  echo "  [!!] suspicious tracked filenames:"
  echo "$HITS"
else
  echo "  [ok] no suspicious tracked filenames"
fi

echo ""
echo "== 3. Scanning current diff (staged + unstaged) for secret-like strings =="
PATTERN='(api[_-]?key|apikey|secret|token|password|passwd|bearer|access[_-]?key|private[_-]?key|sk_live_[a-zA-Z0-9]+|pk_live_[a-zA-Z0-9]+|AKIA[0-9A-Z]{16}|shpat_[a-zA-Z0-9]+|shpca_[a-zA-Z0-9]+|shpss_[a-zA-Z0-9]+)'

MATCHES=$(git diff HEAD -- . 2>/dev/null | grep -inE "$PATTERN" || true)
if [ -n "$MATCHES" ]; then
  echo "  [!!] potential secret-like strings in the diff:"
  echo "$MATCHES"
else
  echo "  [ok] no obvious secret patterns in the diff"
fi

echo ""
echo "== 4. Full-content scan of each modified file (catches things outside the diff context lines) =="
for f in $(git diff --name-only HEAD 2>/dev/null); do
  if [ -f "$f" ]; then
    FILE_HITS=$(grep -inE "$PATTERN" "$f" || true)
    if [ -n "$FILE_HITS" ]; then
      echo "  [!!] $f:"
      echo "$FILE_HITS"
    fi
  fi
done

echo ""
echo "== 5. Has an env/secret file ever been committed in this repo's history? =="
HIST=$(git log --all --full-history --oneline -- '**/.env' '**/.env.*' '**/*secret*' '**/*credential*' 2>/dev/null || true)
if [ -n "$HIST" ]; then
  echo "  [!!] found in history (if pushed already, rotate these keys, deleting the file now isn't enough):"
  echo "$HIST"
else
  echo "  [ok] no matching files in git history"
fi

echo ""
echo "Done. Fix every [!!] above before you push. If a [!!] in section 5"
echo "was already pushed to a remote, treat that key as compromised and rotate it —"
echo "removing it from a future commit does not undo an already-pushed exposure."
