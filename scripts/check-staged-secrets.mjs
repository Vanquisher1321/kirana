#!/usr/bin/env node
/**
 * Refuse a commit that carries a secret.
 *
 * .gitignore only stops the filenames somebody thought of in advance. This
 * reads what is actually STAGED -- content, not names -- so a secret pasted
 * into a source file, a stray `env.txt`, or an archive with a .env inside it
 * is caught by the same check.
 *
 * Run by scripts/hooks/pre-commit; install with `npm run hooks:install`.
 * Bypassable with `git commit --no-verify`, deliberately: a hook that cannot
 * be overridden gets uninstalled the first time it is wrong.
 */
import { execFileSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const ARCHIVE = /\.(tgz|tar|tar\.gz|gz|zip|7z|rar|bz2|xz)$/i;
const ENVISH = /(^|\/)(\.env($|\..*)|[^/]*\.env)$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/** Placeholders and obvious test doubles are not secrets. */
const DECOY = /(x{6,}|fake|dummy|placeholder|example|sample|your[-_]?|<[a-z]+>)/i;

/**
 * The webhook secret the test suite signs its own fixtures with.
 *
 * This scan reads whole STAGED FILES rather than diffs, which is the right
 * choice -- a secret already sitting in a file is still a secret -- but it
 * means a line nobody touched refuses every future commit that goes near it.
 * `whsec_test_kirana` has been a literal in webhook.test.ts since the webhook
 * path was written, it authenticates nothing outside this repository's own
 * tests, and it was blocking edits to the file that contains it.
 *
 * Deliberately this one shape and not the word "test". Adding `test` to DECOY
 * would have been one character shorter and would also have excused
 * `rzp_test_...`, which is a real Razorpay credential whichever mode it is in.
 * A scanner that stops flagging a class of live keys to silence one fixture
 * has been made worse, not quieter.
 */
const TEST_FIXTURE = /\bwhsec_test_/i;

/** A run of one repeated character is a test fixture, not a key. */
const spread = (s) => new Set(s).size;

const RULES = [
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: 'Razorpay API key id', re: /\brzp_(?:live|test)_[A-Za-z0-9]{10,}\b/g, ok: (m) => DECOY.test(m) },
  { name: 'Kirana agent key', re: /\bkag_[A-Za-z0-9_-]{20,}\b/g, ok: (m) => DECOY.test(m) },
  { name: 'workspace session id', re: /\bws_[A-Za-z0-9_-]{24,}\b/g },
  {
    name: 'high-entropy hex (signing-secret shape)',
    re: /\b[a-f0-9]{48,}\b/g,
    // Repeated-character fixtures ('b'.repeat(64)) and the all-zero genesis
    // hash are not credentials; a real secret has broad character spread.
    ok: (m) => spread(m) < 10,
  },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: 'credential assignment',
    re: /\b(?:token|secret|password|passwd|api[-_]?key)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{16,}['"]/gi,
    // TEST_FIXTURE is excused HERE only. The rules above keep judging their own
    // shapes on their own terms, so a Razorpay key is still a Razorpay key
    // however it is spelled or whatever it is assigned to.
    ok: (m) => DECOY.test(m) || TEST_FIXTURE.test(m),
  },
];

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
  .split('\n').map((s) => s.trim()).filter(Boolean);

const problems = [];

for (const path of staged) {
  if (ARCHIVE.test(path)) {
    problems.push(`${path}: archives are never committed -- a secret inside one is invisible to every text scan`);
    continue;
  }
  if (ENVISH.test(path) && !/\.env\.example$/.test(path)) {
    problems.push(`${path}: looks like an environment file`);
    continue;
  }
  if (LOCKFILE.test(path)) continue;

  let content;
  try { content = git(['show', `:${path}`]); } catch { continue; }
  if (content.includes('\u0000')) {
    problems.push(`${path}: binary file staged -- check what is inside it before committing`);
    continue;
  }

  for (const rule of RULES) {
    const found = content.match(rule.re);
    if (!found) continue;
    const real = found.filter((m) => !(rule.ok && rule.ok(m)));
    if (real.length === 0) continue;
    const first = real[0];
    const shown = first.length > 12 ? `${first.slice(0, 4)}...${first.slice(-4)}` : '(redacted)';
    problems.push(`${path}: ${rule.name} -- ${shown}`);
  }
}

if (problems.length > 0) {
  console.error('\nCommit refused. Staged content looks like it contains a secret:\n');
  for (const p of problems) console.error(`  x ${p}`);
  console.error('\nUnstage it (git restore --staged <file>) and add it to .gitignore.');
  console.error('If this is a false positive: git commit --no-verify\n');
  process.exit(1);
}
