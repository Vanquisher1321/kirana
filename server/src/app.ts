import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './lib/config.ts';
import { ingestStorefront, IngestError } from './catalog/ingest.ts';
import { getMerchant, listMerchants, latestRun, searchCatalog } from './catalog/store.ts';
import { buildMcpServer } from './mcp/server.ts';
import { list as auditList, verify as auditVerify, forSubject, record } from './audit/ledger.ts';
import { formatInr } from './lib/money.ts';
import { listPendingConsents, approveConsent, rejectConsent, revokeConsent, getConsent, ConsentError } from './checkout/consent.ts';
import { getQuote } from './checkout/quote.ts';
import { listOrders, getOrder, settleOrder } from './checkout/checkout.ts';
import { listAgents, setAgentCaps } from './checkout/agents.ts';
import { KILL_SWITCH, engageKillSwitch, releaseKillSwitch } from './checkout/guard.ts';
import { circuitState } from './razorpay/client.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function buildApp() {
    const app = Fastify({
      logger: process.env.KIRANA_QUIET
        ? false
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId,responseTime' } } },
      bodyLimit: 2 * 1024 * 1024,
    });

  app.get('/health', async () => ({ ok: true, service: 'kirana', razorpay: config.razorpay.configured }));

  // ---------------------------------------------------------------------------
  // Console API
  // ---------------------------------------------------------------------------

  app.get('/api/merchants', async () =>
    listMerchants().map((m) => {
      const run = latestRun(m.id);
      return {
        ...m,
        products: run ? Number(run.product_count) : 0,
        variants: run ? Number(run.variant_count) : 0,
        adapter: run ? String(run.adapter) : null,
        usedLlm: run ? Number(run.used_llm) === 1 : false,
        warnings: run ? (JSON.parse(String(run.warnings)) as string[]) : [],
        durationMs: run ? Number(run.duration_ms) : 0,
        mcpUrl: `${config.publicOrigin || `http://localhost:${config.port}`}/mcp/${m.slug}`,
      };
    }),
  );

  app.post('/api/ingest', async (request, reply) => {
    const body = request.body as { url?: string } | undefined;
    if (!body?.url) return reply.code(400).send({ error: 'url is required' });
    try {
      const report = await ingestStorefront(body.url);
      const merchant = getMerchant(report.merchantId)!;
      return {
        ...report,
        merchant,
        mcpUrl: `${config.publicOrigin || `http://localhost:${config.port}`}/mcp/${merchant.slug}`,
      };
    } catch (err) {
      if (err instanceof IngestError) return reply.code(422).send({ error: err.message, origin: err.origin });
      request.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get('/api/merchants/:slug/products', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const m = getMerchant(slug);
    if (!m) return reply.code(404).send({ error: 'merchant not found' });
    const q = (request.query as { q?: string }).q;
    return searchCatalog(m.id, { query: q, limit: 100 }).map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, priceFormatted: formatInr(v.priceMinor) })),
    }));
  });

  app.get('/api/audit', async (request) => {
    const { subject, limit } = request.query as { subject?: string; limit?: string };
    return subject ? forSubject(subject) : auditList(Number(limit ?? 200));
  });

  app.get('/api/audit/verify', async () => auditVerify());

  // -------------------------------------------------------------------------
  // Approvals — the human half of the loop.
  // -------------------------------------------------------------------------

  app.get('/api/approvals', async () =>
    listPendingConsents().map((c) => {
      const q = getQuote(c.quoteId);
      return {
        ...c,
        capFormatted: formatInr(c.capMinor),
        quote: q && {
          id: q.id,
          total: formatInr(q.totalMinor),
          totalMinor: q.totalMinor,
          lines: q.lines.map((l) => ({
            item: `${l.productTitle} — ${l.variantTitle}`,
            quantity: l.quantity,
            unitPrice: formatInr(l.unitPriceMinor),
            lineTotal: formatInr(l.lineTotalMinor),
          })),
        },
      };
    }),
  );

  app.post('/api/approvals/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const by = (request.body as { by?: string } | undefined)?.by ?? 'om';
    try { return approveConsent(id, by); }
    catch (err) {
      if (err instanceof ConsentError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/api/approvals/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    return rejectConsent(id, (request.body as { by?: string } | undefined)?.by ?? 'om');
  });

  app.post('/api/approvals/:id/revoke', async (request) => {
    const { id } = request.params as { id: string };
    return revokeConsent(id, (request.body as { by?: string } | undefined)?.by ?? 'om');
  });

  app.get('/api/approvals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const c = getConsent(id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const q = getQuote(c.quoteId);
    return { ...c, capFormatted: formatInr(c.capMinor), quote: q };
  });

  // -------------------------------------------------------------------------
  // Orders, agents, and the stop button.
  // -------------------------------------------------------------------------

  app.get('/api/orders', async () =>
    listOrders(100).map((o) => ({
      id: String(o.id), status: String(o.status),
      amount: formatInr(Number(o.amount_minor)), amountMinor: Number(o.amount_minor),
      currency: String(o.currency),
      razorpayOrderId: (o.razorpay_order_id as string | null) ?? null,
      razorpayPaymentId: (o.razorpay_payment_id as string | null) ?? null,
      failureReason: (o.failure_reason as string | null) ?? null,
      agentId: (o.agent_id as string | null) ?? null,
      createdAt: String(o.created_at),
    })),
  );

  app.get('/api/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const o = getOrder(id);
    if (!o) return reply.code(404).send({ error: 'not_found' });
    return { ...o, amountFormatted: formatInr(Number(o.amount_minor)), audit: forSubject(id) };
  });

  app.get('/api/agents', async () =>
    listAgents().map((a) => ({ ...a, perOrderCap: formatInr(a.perOrderCapMinor), dailyCap: formatInr(a.dailyCapMinor) })),
  );

  app.post('/api/agents/:id/caps', async (request, reply) => {
    const { id } = request.params as { id: string };
    const b = request.body as { perOrderMinor?: number; dailyMinor?: number };
    const updated = setAgentCaps(id, Number(b.perOrderMinor), Number(b.dailyMinor));
    return updated ?? reply.code(404).send({ error: 'not_found' });
  });

  app.get('/api/system', async () => ({
    killSwitch: { engaged: KILL_SWITCH.engaged, reason: KILL_SWITCH.reason },
    gateway: circuitState(),
    razorpay: { configured: config.razorpay.configured, mode: 'test' },
  }));

  app.post('/api/system/kill-switch', async (request) => {
    const b = request.body as { engage?: boolean; reason?: string };
    if (b.engage) engageKillSwitch(b.reason ?? 'stopped from the console');
    else releaseKillSwitch();
    record({
      actor: 'human:console',
      action: b.engage ? 'kill_switch.engaged' : 'kill_switch.released',
      subjectId: null, outcome: 'ok', detail: { reason: b.reason ?? null },
    });
    return { engaged: KILL_SWITCH.engaged, reason: KILL_SWITCH.reason };
  });

  // -------------------------------------------------------------------------
  // Razorpay webhook. Signature is verified before the body is trusted.
  // -------------------------------------------------------------------------

  app.post('/webhooks/razorpay', { config: { rawBody: true } }, async (request, reply) => {
    const secret = config.razorpay.webhookSecret;
    const signature = String(request.headers['x-razorpay-signature'] ?? '');
    const raw = JSON.stringify(request.body);

    if (secret) {
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      const valid = a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
      if (!valid) {
        record({ actor: 'razorpay:webhook', action: 'webhook.rejected', subjectId: null, outcome: 'blocked', detail: { reason: 'bad signature' } });
        return reply.code(400).send({ error: 'invalid signature' });
      }
    }

    const body = request.body as { event?: string; payload?: Record<string, { entity?: Record<string, unknown> }> };
    const event = body.event ?? 'unknown';
    const payment = body.payload?.payment?.entity as Record<string, unknown> | undefined;
    const link = body.payload?.payment_link?.entity as Record<string, unknown> | undefined;

    if (event === 'payment.captured' && payment) {
      settleOrder({
        razorpayOrderId: (payment.order_id as string) ?? undefined,
        referenceId: (link?.reference_id as string) ?? undefined,
        paymentId: String(payment.id), status: 'paid',
      });
    } else if (event === 'payment.failed' && payment) {
      settleOrder({
        razorpayOrderId: (payment.order_id as string) ?? undefined,
        paymentId: String(payment.id), status: 'failed',
        failureReason: `${String(payment.error_code ?? 'failed')}: ${String(payment.error_description ?? '')}`,
      });
    } else {
      record({ actor: 'razorpay:webhook', action: 'webhook.ignored', subjectId: null, outcome: 'ok', detail: { event } });
    }

    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // MCP endpoint, one per merchant.
  //
  // Stateless: a fresh server + transport per request. There is no session state
  // worth keeping between calls, and statelessness means a dropped tunnel or a
  // restarted process never strands a buyer agent mid-conversation.
  // ---------------------------------------------------------------------------

  app.all('/mcp/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const merchant = getMerchant(slug);
    if (!merchant) {
      return reply.code(404).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: `No merchant "${slug}" has been ingested on this server.` },
        id: null,
      });
    }

    if (request.method === 'GET' || request.method === 'DELETE') {
      return reply.code(405).header('allow', 'POST').send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'This MCP endpoint is stateless; use POST.' },
        id: null,
      });
    }

    const agentId = (request.headers['x-kirana-agent'] as string | undefined) ?? null;
    const server = buildMcpServer(merchant, agentId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // -------------------------------------------------------------------------
  // The console. Served by the same process as the API so the whole demo is a
  // single command and a single port -- one less thing to go wrong on camera.
  // Run `npm run dev` in web/ instead while actually building the UI.
  // -------------------------------------------------------------------------

  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(join(webDist, 'index.html'))) {
    void app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // The approval link handed to buyer agents, and any client-side route,
    // resolve to the single-page app rather than a 404.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/mcp') || request.url.startsWith('/webhooks')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      service: 'kirana',
      note: 'Console not built yet. Run `npm run build:web` from the repo root, or `npm run dev` inside web/ for live reload on port 5173.',
    }));
  }

  return app;
}
