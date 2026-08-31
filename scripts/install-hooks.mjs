#!/usr/bin/env node
/**
 * Git hooks live in .git/hooks, which is not version-controlled -- so a hook
 * committed to the repo protects nobody until it is copied into place. This
 * does the copying, and `npm run hooks:install` is the documented step.
 */
import { copyFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const hooksPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8', cwd: root }).trim();
const target = isAbsolute(hooksPath) ? hooksPath : join(root, hooksPath);
if (!existsSync(target)) mkdirSync(target, { recursive: true });

for (const hook of ['pre-commit']) {
  const dest = join(target, hook);
  copyFileSync(join(root, 'scripts', 'hooks', hook), dest);
  try { chmodSync(dest, 0o755); } catch { /* Windows ignores the mode */ }
  console.log(`installed ${hook} -> ${dest}`);
}
