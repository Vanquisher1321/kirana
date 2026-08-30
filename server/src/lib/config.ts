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

let signingSecret = opt('KIRANA_SIGNING_SECRET');
let signingIsEphemeral = false;
if (!signingSecret) {
  signingSecret = randomBytes(32).toString('hex');
  signingIsEphemeral = true;
}

export const config = {
  port: Number(opt('PORT', '3000')),
  publicOrigin: opt('PUBLIC_ORIGIN').replace(/\/+$/, ''),
  dbPath: opt('KIRANA_DB', 'data/kirana.db'),
  signingSecret,
  signingIsEphemeral,
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
  lines.push(`llm provider        ${config.llm.provider}${config.llm.provider === 'none' ? ' (structured-feed ingestion only)' : ''}`);
  return lines;
}
