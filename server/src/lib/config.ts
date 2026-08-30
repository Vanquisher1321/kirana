import { randomBytes } from 'node:crypto';

/**
 * Config is read once, validated loudly, and never re-read. Env is loaded by
 * Node itself via --env-file-if-exists=.env, so there is no dotenv dependency.
 */

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  configured: boolean;
}

function loadRazorpay(): RazorpayConfig {
  const keyId = opt('RAZORPAY_KEY_ID');
  const keySecret = opt('RAZORPAY_KEY_SECRET');

  if (keyId && !keyId.startsWith('rzp_test_')) {
    // A hard refusal, not a warning. A hackathon project has no business
    // holding a live key, and "it was only a demo" is not a defence anyone
    // wants to make to a payments company.
    throw new Error(
      `RAZORPAY_KEY_ID is "${keyId.slice(0, 12)}..." which is not a test key. ` +
      `Kirana refuses to start with live credentials — use a key beginning rzp_test_.`,
    );
  }

  return {
    keyId,
    keySecret,
    webhookSecret: opt('RAZORPAY_WEBHOOK_SECRET'),
    configured: Boolean(keyId && keySecret),
  };
}

let consoleToken = opt('KIRANA_CONSOLE_TOKEN');
let consoleTokenGenerated = false;
if (!consoleToken) {
  // Never default to "no authentication". An unset token means a fresh one is
  // minted at boot and printed once -- inconvenient by design, because the
  // alternative is a console that anyone who finds the URL can spend from.
  consoleToken = randomBytes(18).toString('base64url');
  consoleTokenGenerated = true;
}

let signingSecret = opt('KIRANA_SIGNING_SECRET');
let signingIsEphemeral = false;
if (!signingSecret) {
  signingSecret = randomBytes(32).toString('hex');
  signingIsEphemeral = true;
}

/**
 * Access model. Two modes, and the default is chosen by where the server sits.
 *
 *   demo   — nothing is gated. For the public sandbox a judge opens, and for
 *            local development, where a login wall is pure friction.
 *   locked — reading is open, but approving, connecting a shop, pausing or
 *            issuing a key needs the operator's token. For anything real.
 *
 * The default is `demo` on plain localhost and `locked` the moment the server
 * is publicly reachable (PUBLIC_ORIGIN set), because a console exposed to the
 * internet should not be open by accident. KIRANA_ACCESS overrides both.
 *
 * The public sandbox deliberately runs `demo` with a permanent banner. That is
 * not a hole in the security model — it is Razorpay TEST credentials, where no
 * real money can move, the server refuses to start on a live key, and every
 * spend is still capped at ₹2,000 per order. The threat model in SECURITY.md
 * describes a real merchant's console; a sandbox anyone can drive is the point.
 */
const accessRaw = opt('KIRANA_ACCESS').toLowerCase();
const access: 'demo' | 'locked' =
  accessRaw === 'demo' || accessRaw === 'locked'
    ? accessRaw
    : (opt('PUBLIC_ORIGIN') ? 'locked' : 'demo');

export const config = {
  port: Number(opt('PORT', '3000')),
  access,
  isDemo: access === 'demo',
  publicOrigin: opt('PUBLIC_ORIGIN').replace(/\/+$/, ''),
  dbPath: opt('KIRANA_DB', 'data/kirana.db'),
  signingSecret,
  signingIsEphemeral,
  consoleToken,
  consoleTokenGenerated,
  razorpay: loadRazorpay(),
  llm: {
    provider: opt('LLM_PROVIDER', 'none') as 'none' | 'ollama' | 'groq' | 'gemini',
    ollamaHost: opt('OLLAMA_HOST', 'http://127.0.0.1:11434'),
    ollamaModel: opt('OLLAMA_MODEL', 'llama3.1:8b'),
    groqKey: opt('GROQ_API_KEY'),
    geminiKey: opt('GEMINI_API_KEY'),
  },
} as const;

/** Human-readable boot report. Never prints a secret, only whether one exists. */
export function describeConfig(): string[] {
  const lines: string[] = [];
  lines.push(`port                ${config.port}`);
  lines.push(`database            ${config.dbPath}`);
  lines.push(`public origin       ${config.publicOrigin || '(not set — MCP URLs will use localhost)'}`);
  lines.push(`razorpay            ${config.razorpay.configured ? `configured (${config.razorpay.keyId.slice(0, 16)}…, TEST mode)` : 'NOT configured — checkout disabled'}`);
  lines.push(`razorpay webhooks   ${config.razorpay.webhookSecret ? 'secret present' : 'no secret — webhook verification disabled'}`);
  lines.push(`quote signing       ${config.signingIsEphemeral ? 'EPHEMERAL (set KIRANA_SIGNING_SECRET to persist across restarts)' : 'persistent secret'}`);
  lines.push(`console access      ${config.isDemo ? 'DEMO — open, no token needed (sandbox)' : 'LOCKED — token required to approve, connect or pause'}`);
  lines.push(`llm provider        ${config.llm.provider}${config.llm.provider === 'none' ? ' (structured-feed ingestion only)' : ''}`);
  if (config.publicOrigin && !config.razorpay.webhookSecret) {
    lines.push('WARNING             publicly reachable with no webhook secret — webhooks will be refused');
  }
  if (config.consoleTokenGenerated && !config.isDemo) {
    lines.push('');
    lines.push('  Console token (generated for this run — set KIRANA_CONSOLE_TOKEN to keep it):');
    lines.push(`      ${config.consoleToken}`);
    lines.push('  Paste it into the console when it asks. Anyone with this token can approve spending.');
  }
  return lines;
}
