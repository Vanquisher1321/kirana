#!/usr/bin/env bash
# Quick secret-exposure check before git push.
# Run from the repo root (git bash on Windows works fine):
#   bash check-secrets.sh
#
# Exits 0 when clean, 1 when something needs a human. That exit code is the
# point: a check that always prints a warning is a check nobody reads, and the
# run where it catches something real looks exactly like every other run.
#
# This script used to do that. Section 2 flagged every file whose NAME contains
# "secret" -- which is to say, itself and the pre-commit hook -- and section 5
# flagged .env.example, a file that is supposed to be committed and can never
# leave the history. Two [!!] lines on every run, forever, none of them real,
# under a footer telling you to fix them all before pushing.
#
# scripts/check-staged-secrets.mjs already had the right idea and this file did
# not: know the difference between a secret and a placeholder, and between a
# secret and a file that talks about secrets. The rules below borrow its
# vocabulary so the two agree.

set -uo pipefail

FAILED=0
flag() { FAILED=1; echo "  [!!] $1"; }

# A value that is obviously a stand-in, using the same vocabulary as the
# pre-commit hook: xxxxxx, fake, dummy, placeholder, example, sample, your-key,
# <angle-brackets>.
DECOY='(x{6,}|fake|dummy|placeholder|example|sample|your[-_]?|<[a-z]+>|redacted|changeme)'

# Files that are MEANT to be committed and will always look secret-shaped:
# templates, and the two checkers whose whole job is to contain these words.
EXPECTED='(\.(example|sample|template|dist)$|check-secrets\.sh$|check-staged-secrets\.mjs$)'

echo "== 1. .gitignore coverage for common secret files =="
for pattern in ".env" "*.pem" "*.key" "secrets" "credentials"; do
  if grep -q -- "$pattern" .gitignore 2>/dev/null; then
    echo "  [ok] $pattern is in .gitignore"
  else
    flag "$pattern NOT in .gitignore"
  fi
done

echo ""
echo "== 2. Tracked files that look like secrets =="
HITS=$(git ls-files \
  | grep -iE '\.env($|\.)|secret|credential|\.pem$|\.key$|id_rsa' \
  | grep -vE "$EXPECTED" || true)
if [ -n "$HITS" ]; then
  flag "suspicious tracked filenames:"
  echo "$HITS"
else
  echo "  [ok] no suspicious tracked filenames"
  echo "       (templates and the checkers themselves are expected and skipped)"
fi

echo ""
echo "== 3. Scanning current diff (staged + unstaged) for secret-like strings =="
# A keyword needs an actual VALUE after it to count. The old pattern matched the
# bare words, so every comment in security.ts about how keys are hashed, and the
# word "Password" on the sign-in screen, read as a leak.
ASSIGNED='(api[_-]?key|apikey|secret|token|password|passwd|bearer|access[_-]?key|private[_-]?key)["'"'"']?\s*[:=]\s*["'"'"'][^"'"'"']{8,}'
VENDOR='(sk_live_[a-zA-Z0-9]{8,}|pk_live_[a-zA-Z0-9]{8,}|AKIA[0-9A-Z]{16}|shp(at|ca|ss)_[a-zA-Z0-9]{8,}|rzp_(live|test)_[A-Za-z0-9]{10,}|kag_[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
PATTERN="($ASSIGNED|$VENDOR)"

scan() { grep -inE "$PATTERN" | grep -viE "$DECOY" || true; }

MATCHES=$(git diff HEAD -- . 2>/dev/null | scan)
if [ -n "$MATCHES" ]; then
  flag "potential secret-like strings in the diff:"
  echo "$MATCHES"
else
  echo "  [ok] no obvious secret patterns in the diff"
fi

echo ""
echo "== 4. Full-content scan of each modified file =="
SEC4=0
for f in $(git diff --name-only HEAD 2>/dev/null); do
  case "$f" in *.example|*.sample|*.template) continue ;; esac
  if [ -f "$f" ]; then
    FILE_HITS=$(scan < "$f")
    if [ -n "$FILE_HITS" ]; then
      flag "$f:"
      echo "$FILE_HITS"
      SEC4=1
    fi
  fi
done
[ "$SEC4" -eq 0 ] && echo "  [ok] nothing secret-shaped in the modified files"

echo ""
echo "== 5. Has a real secret file ever been committed in this repo's history? =="
# .env.example is excluded on purpose. It is committed deliberately, it is in
# every commit that ever touched it, and it cannot be removed from history --
# so flagging it means flagging every run of this script until the end of time.
HIST=$(git log --all --full-history --oneline \
  -- '**/.env' '**/*secret*' '**/*credential*' \
     ':(exclude)**/.env.example' ':(exclude)**/.env.sample' \
     ':(exclude)check-secrets.sh' ':(exclude)scripts/check-staged-secrets.mjs' \
  2>/dev/null || true)
if [ -n "$HIST" ]; then
  flag "found in history (if pushed already, rotate these keys — deleting the file now does not undo it):"
  echo "$HIST"
else
  echo "  [ok] no real secret files in git history"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "Clean. Nothing above needs a human."
  exit 0
fi
echo "Fix every [!!] above before you push. If a [!!] in section 5 was already"
echo "pushed to a remote, treat that key as compromised and rotate it —"
echo "removing it from a future commit does not undo an already-pushed exposure."
exit 1
