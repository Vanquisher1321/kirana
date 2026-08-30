import Fastify from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './lib/config.ts';
import { ingestStorefront, IngestError } from './catalog/ingest.ts';
import { getMerchant, listMerchants, latestRun, searchCatalog } from './catalog/store.ts';
import { buildMcpServer } from './mcp/server.ts';
import { list as auditList, verify as auditVerify, forSubject } from './audit/ledger.ts';
import { formatInr } from './lib/money.ts';

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

  return app;
}
