/**
 * A buyer agent, in a terminal.
 *
 * This exists as insurance and as evidence. Insurance, because the demo must
 * not depend on a connector UI accepting a URL five minutes before recording.
 * Evidence, because it proves the MCP endpoint is a real protocol surface that
 * ANY agent can drive -- not something that only works because Claude is
 * unusually forgiving.
 *
 *   npm run agent -- --url http://localhost:3000/mcp/bluehill-example \
 *                    --want "medium roast coffee" --budget 1500 --qty 2
 */

interface Rpc { jsonrpc: '2.0'; id: number; method: string; params?: unknown; }

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, '');
  if (k) args.set(k, process.argv[i + 1] ?? '');
}

const url = args.get('url') ?? 'http://localhost:3000/mcp/bluehill-example';
const want = args.get('want') ?? 'coffee';
const budget = Number(args.get('budget') ?? 1500);
const qty = Number(args.get('qty') ?? 1);
const agentId = args.get('agent') ?? 'cli-buyer';

let id = 0;
async function rpc<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
  const body: Rpc = { jsonrpc: '2.0', id: ++id, method, params: params ?? {} };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-kirana-agent': agentId,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const payload = frames.length ? frames[frames.length - 1]! : text;
  const parsed = JSON.parse(payload) as { result?: T; error?: { message?: string } };
  if (parsed.error) throw new Error(parsed.error.message ?? 'rpc error');
  return parsed.result as T;
}

async function callTool(name: string, argsObj: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await rpc<{ content?: Array<{ text?: string }> }>('tools/call', { name, arguments: argsObj });
  return JSON.parse(r.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

const step = (n: string, s: string) => console.log(`\n\x1b[33m${n}\x1b[0m  ${s}`);
const say = (s: string) => console.log(`   ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`\x1b[2mbuyer agent "${agentId}" -> ${url}\x1b[0m`);

step('1', 'Introducing myself to the shop');
const init = await rpc<{ serverInfo?: { name?: string } }>('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kirana-cli-buyer', version: '0.1' },
});
say(`connected to ${init.serverInfo?.name}`);

const info = await callTool('get_merchant_info');
const catalog = info.catalog as Record<string, unknown>;
say(`${String(info.name)} — ${catalog.products} products, read from ${String(catalog.source)}`);
say(catalog.extracted_by_model ? 'note: a model interpreted parts of this catalog' : 'no model guessed at any price here');

step('2', `Looking for "${want}" under ₹${budget}`);
const found = await callTool('search_products', { query: want, max_price_inr: budget, in_stock_only: true, limit: 5 });
const products = (found.products ?? []) as Array<Record<string, unknown>>;
if (products.length === 0) { console.log('\n   nothing matched — try a different --want or a bigger --budget'); process.exit(1); }
for (const p of products) say(`${String(p.title)} — from ${String(p.price_from)}`);

const chosen = products[0]!;
const variants = (chosen.variants as Array<Record<string, unknown>>).filter((v) => v.in_stock);
if (variants.length === 0) { console.log('\n   everything matching is out of stock'); process.exit(1); }
const variant = variants[0]!;

step('3', `Asking the price for ${qty} × ${String(chosen.title)} (${String(variant.title)})`);
const quote = await callTool('create_quote', { items: [{ variant_id: variant.variant_id, quantity: qty }] });
if (quote.error) { console.log(`   refused: ${String(quote.message)}`); process.exit(1); }
say(`subtotal ${String(quote.subtotal)}  shipping ${String(quote.shipping)}  total \x1b[1m${String(quote.total)}\x1b[0m`);
say(`this price is signed and expires at ${String(quote.expires_at)}`);

step('4', `Asking a human to approve up to ₹${budget}`);
const approval = await callTool('request_approval', { quote_id: quote.quote_id, spend_cap_inr: budget });
if (approval.error) { console.log(`   refused: ${String(approval.message)}`); process.exit(1); }
say(`approval ${String(approval.consent_id)} is PENDING — I cannot approve this myself`);
say(`\x1b[36m${String(approval.approve_url)}\x1b[0m`);
console.log('\n   waiting for a human to approve in the console…');

let granted = false;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const status = await callTool('get_approval', { consent_id: approval.consent_id });
  if (status.status === 'granted') { granted = true; say(`approved by ${String(status.approved_by)}`); break; }
  if (status.status !== 'pending') { say(`approval is ${String(status.status)} — stopping`); process.exit(1); }
  process.stdout.write('.');
}
if (!granted) { console.log('\n   timed out waiting for approval'); process.exit(1); }

step('5', 'Paying');
const paid = await callTool('checkout', { quote_id: quote.quote_id, consent_id: approval.consent_id });
const gates = (paid.gates ?? []) as Array<Record<string, unknown>>;
for (const g of gates) say(`${g.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${String(g.enforces)}`);

if (paid.blocked_by) {
  console.log(`\n   \x1b[31mstopped at "${String(paid.blocked_by)}"\x1b[0m — ${String(paid.reason)}`);
  process.exit(1);
}

say(`order ${String(paid.order_id)} for ${String(paid.amount)}`);
say(`pay here: \x1b[36m${String(paid.pay_url)}\x1b[0m`);

step('6', 'Watching for the money to land');
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const o = await callTool('get_order', { order_id: paid.order_id });
  if (o.status === 'paid') { console.log(`\n   \x1b[32mPAID\x1b[0m — ${String(o.amount)}, Razorpay payment ${String(o.razorpay_payment_id)}`); process.exit(0); }
  if (o.status === 'failed') { console.log(`\n   \x1b[31mFAILED\x1b[0m — ${String(o.failure_reason)}`); process.exit(1); }
  process.stdout.write('.');
}
console.log('\n   still unpaid. The reconciler will settle it whenever the payment lands.');
