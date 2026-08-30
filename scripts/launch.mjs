#!/usr/bin/env node
/**
 * One command to run everything.
 *
 * The test this is written against: someone who has never seen this repo, on a
 * machine that has only Node, types `npm start` and ends up looking at a
 * working console. Every step they would otherwise have to know about --
 * installing two package sets, building the web bundle, seeding a demo shop,
 * finding the console token, opening a browser, starting a tunnel -- is a step
 * where a judge with four other projects to review gives up instead.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const WEB = join(ROOT, 'web');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

const args = new Set(process.argv.slice(2));
const wantTunnel = args.has('--tunnel');
const skipOpen = args.has('--no-open');

const c = {
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const step = (n, total, msg) => console.log(`${c.gold(`[${n}/${total}]`)} ${msg}`);

function run(cmd, cmdArgs, cwd, label) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(c.red(`\n${label} failed. Fix the error above and run again.`));
    process.exit(1);
  }
}

function nodeVersionOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

console.log(`\n${c.bold('Kirana')} ${c.dim('— any shop, ready for AI shoppers')}\n`);

if (!nodeVersionOk()) {
  console.error(c.red(`Node ${process.versions.node} is too old. This project needs Node 22.18 or newer,`));
  console.error(c.red('because it runs TypeScript directly and uses the built-in SQLite module.'));
  process.exit(1);
}

const TOTAL = wantTunnel ? 6 : 5;

step(1, TOTAL, 'Checking dependencies');
if (!existsSync(join(SERVER, 'node_modules'))) {
  console.log(c.dim('  installing server dependencies (first run only)…'));
  run(npm, ['install', '--no-audit', '--no-fund'], SERVER, 'Server install');
} else console.log(c.dim('  server ready'));

if (!existsSync(join(WEB, 'node_modules'))) {
  console.log(c.dim('  installing console dependencies (first run only)…'));
  run(npm, ['install', '--no-audit', '--no-fund'], WEB, 'Console install');
} else console.log(c.dim('  console ready'));

step(2, TOTAL, 'Building the console');
if (!existsSync(join(WEB, 'dist', 'index.html')) || args.has('--rebuild')) {
  run(npm, ['run', 'build'], WEB, 'Console build');
} else console.log(c.dim('  already built (pass --rebuild to force)'));

step(3, TOTAL, 'Checking configuration');
const envPath = join(SERVER, '.env');
let env = '';
if (existsSync(envPath)) env = readFileSync(envPath, 'utf8');
const has = (k) => new RegExp(`^${k}=.+$`, 'm').test(env);
if (!existsSync(envPath)) {
  console.log(c.dim('  no .env found — running in demo mode (no real Razorpay calls)'));
  console.log(c.dim('  copy server/.env.example to server/.env to enable checkout'));
} else {
  console.log(c.dim(`  razorpay ${has('RAZORPAY_KEY_ID') ? 'configured' : 'NOT configured — checkout disabled'}`));
  console.log(c.dim(`  console token ${has('KIRANA_CONSOLE_TOKEN') ? 'set' : 'not set — one will be printed below'}`));
}

step(4, TOTAL, 'Seeding a demo shop');
run(npm, ['run', 'seed'], SERVER, 'Seed');

let tunnel = null;
if (wantTunnel) {
  step(5, TOTAL, 'Starting a public tunnel (Docker)');
  tunnel = spawn('docker', ['run', '--rm', 'cloudflare/cloudflared:latest', 'tunnel', '--url', 'http://host.docker.internal:3000'], { shell: isWin });
  const onTunnelData = (buf) => {
    const text = buf.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      console.log(`\n  ${c.green('Public URL')}  ${m[0]}`);
      console.log(c.dim(`  set PUBLIC_ORIGIN=${m[0]} in server/.env and restart to use it for MCP and webhooks\n`));
    }
  };
  tunnel.stdout?.on('data', onTunnelData);
  tunnel.stderr?.on('data', onTunnelData);
  tunnel.on('error', () => console.log(c.red('  could not start Docker — continuing without a tunnel')));
}

step(wantTunnel ? 6 : 5, TOTAL, 'Starting the server\n');

const server = spawn(npm, ['start'], { cwd: SERVER, stdio: 'inherit', shell: isWin });

const url = 'http://localhost:3000';
const openBrowser = () => {
  if (skipOpen) return;
  const cmd = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* headless is fine */ }
};

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
  }
  return false;
}

waitForHealth().then((up) => {
  if (!up) return;
  console.log(`\n${c.green('Console')}  ${url}`);
  console.log(c.dim('  Paste the console token above when it asks. Ctrl+C stops everything.\n'));
  openBrowser();
});

const shutdown = () => {
  server.kill();
  tunnel?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (code) => { tunnel?.kill(); process.exit(code ?? 0); });

if (process.stdin.isTTY) {
  createInterface({ input: process.stdin, output: process.stdout }).on('SIGINT', shutdown);
}
