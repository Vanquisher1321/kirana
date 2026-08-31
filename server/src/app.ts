import Fastify from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './lib/config.ts';
import { ingestStorefront, IngestError } from './catalog/ingest.ts';
import { getMerchant, getMerchantForMcp, listMerchants, latestRun, searchCatalog } from './catalog/store.ts';
import { buildMcpServer } from './mcp/server.ts';
import { list as auditList, verify as auditVerify, forSubject, record } from './audit/ledger.ts';
import { formatInr } from './lib/money.ts';
import { listPendingConsents, approveConsent, rejectConsent, revokeConsent, getConsent, ConsentError } from './checkout/consent.ts';
import { getQuote } from './checkout/quote.ts';
import { listOrders, getOrder, settleOrder } from './checkout/checkout.ts';
import { reconcile } from './checkout/reconcile.ts';
import { listAgents, setAgentCaps, issueAgentKey, agentForKey, ensureAgent } from './checkout/agents.ts';
import { secretEquals, rateLimit } from './lib/security.ts';
import { KILL_SWITCH, engageKillSwitch, releaseKillSwitch, killSwitchActive } from './checkout/guard.ts';
import { enforceMerchantCap } from './lib/selfheal.ts';
import { COOKIE, ROLES, cookieHeader, createWorkspace, getWorkspace, readCookie, setWorkspaceRole, touchWorkspace, type Role } from './lib/workspace.ts';
import { circuitState } from './razorpay/client.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBundle, lookup } from './lib/staticfiles.ts';

export function buildApp() {
    const app = Fastify({
      logger: process.env.KIRANA_QUIET
        ? false
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId,responseTime' } } },
      bodyLimit: 2 * 1024 * 1024,
    });

  // Razorpay signs the EXACT bytes it sends. Verifying against a re-serialised
  // body (JSON.stringify(request.body)) compares our formatting to their
  // formatting and fails on key order, spacing or unicode escaping -- so every
  // genuine webhook would be rejected as a forgery. The raw string is kept.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body || (body as string).length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  /**
   * Two different callers, two different rules.
   *
   *   /api/*  is the HUMAN console. It can approve spending, pause the system
   *           and read the audit trail, so it requires a bearer token.
   *   /mcp/*  is the BUYER AGENT surface. It must stay open -- an ecosystem
   *           where any agent can shop any merchant cannot gate discovery
   *           behind a credential -- so it is protected by caps, consent and
   *           rate limits instead of by a password.
   *
   * Getting this backwards is the common mistake: people authenticate the
   * agent and leave the approve button open.
   */
  app.addHook('onRequest', async (request, reply) => {
    // Authorise on the MATCHED ROUTE, never on the raw URL.
    //
    // request.url is the raw, undecoded target. Fastify's router decodes and
    // normalises before matching, so `/%61pi/...`, `/API/...` and `//api/...`
    // all reach the /api/ handlers while a raw-string prefix test sees
    // something that does not begin with "/api/". All three bypassed this hook
    // until it was moved onto routeOptions.url, which is the canonical pattern
    // the router actually matched.
    const route = request.routeOptions?.url ?? '';

    if (route.startsWith('/api/')) {
      // Every visitor gets their own workspace, silently, the way any normal
      // site issues a session. No signup, no friction — and no visitor ever
      // sees another's shops, approvals or orders.
      const existing = readCookie(request.headers.cookie, COOKIE);
      let ws = existing ? getWorkspace(existing) : null;
      if (!ws) {
        ws = createWorkspace();
        reply.header('set-cookie', cookieHeader(ws.id, Boolean(config.publicOrigin)));
      } else {
        touchWorkspace(ws.id);
      }
      const req = request as unknown as { workspaceId: string; workspaceRole: Role | null };
      req.workspaceId = ws.id;
      req.workspaceRole = ws.role;

      const header = String(request.headers.authorization ?? '');
      const presented = header.startsWith('Bearer ') ? header.slice(7) : String(request.headers['x-kirana-console'] ?? '');
      const wantsPlatform = (request.query as { scope?: string } | undefined)?.scope === 'platform';

      // A sandbox is meant to be driven, not admired. Test credentials only.
      if (config.isDemo) return;

      // Cross-tenant reads are privileged even though ordinary reads are open.
      if (wantsPlatform && !secretEquals(presented, config.consoleToken)) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'The platform view reads across every workspace and needs the operator token.',
        });
      }

      if (secretEquals(presented, config.consoleToken)) return;

      // Locked: reading stays open so the console is legible, but every
      // endpoint that spends, approves, ingests, pauses or issues a key is a
      // POST -- so the verb is the whole distinction.
      if (request.method === 'GET') return;

      // A failed console auth is both rate-limited and recorded. Without this
      // a credential-stuffing run against the approve endpoint is unlimited and
      // leaves nothing in the very audit trail this project offers as evidence.
      const source = request.ip || 'unknown';
      const attempts = rateLimit(`console-auth:${source}`, 10, 60_000);
      record({
        actor: `anonymous:${source}`,
        action: 'console.auth_failed',
        subjectId: null,
        outcome: 'blocked',
        detail: { route, method: request.method, tokenPresented: presented.length > 0, rateLimited: !attempts.ok },
      });
      if (!attempts.ok) {
        return reply.code(429).header('retry-after', Math.ceil(attempts.retryAfterMs / 1000))
          .send({ error: 'rate_limited', message: 'Too many failed attempts.' });
      }
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Approving, connecting a shop and pausing need the operator token.',
      });
    }

    if (route.startsWith('/mcp/')) {
      const key = String(request.headers['x-kirana-agent-key'] ?? '');
      const label = String(request.headers['x-kirana-agent'] ?? '');
      const identity = key ? (agentForKey(key)?.id ?? null) : null;
      if (key && !identity) {
        return reply.code(401).send({
          jsonrpc: '2.0', id: null,
          error: { code: -32002, message: 'That agent key is not recognised.' },
        });
      }
      // A verified key wins; otherwise a self-asserted label is accepted but
      // stays permanently capped at the unregistered ceiling.
      const req = request as unknown as { agentId: string | null; identityProven: boolean };
      req.agentId = identity ?? (label || null);
      // Proven ONLY by a key that matched. A name in a header proves nothing.
      req.identityProven = Boolean(identity);

      // Only a VERIFIED identity gets its own budget. A self-asserted header is
      // free to rotate, so bucketing on it means no limit at all; anonymous and
      // name-only callers are bucketed by source address instead.
      const bucket = identity || `ip:${request.ip || 'unknown'}`;
      const limited = rateLimit(`mcp:${bucket}`, 120, 60_000);
      if (!limited.ok) {
        return reply.code(429).header('retry-after', Math.ceil(limited.retryAfterMs / 1000)).send({
          jsonrpc: '2.0', id: null,
          error: { code: -32003, message: 'Too many requests. Slow down and retry shortly.' },
        });
      }
    }
  });

  /** The tenant behind this request. */
  const ws = (request: { workspaceId?: string }) => (request as { workspaceId?: string }).workspaceId ?? null;

  /**
   * Scope for a read.
   *
   * The Razorpay persona is the one view that legitimately reads ACROSS
   * tenants — that is what a platform console is. Everything else is confined
   * to the caller's own workspace. `undefined` means "every tenant"; a string
   * means "this one".
   *
   * On the public sandbox this is open, and the banner says so. A real
   * deployment runs KIRANA_ACCESS=locked, where reaching it needs the operator
   * token like every other privileged action.
   */
  const scopeFor = (request: { workspaceId?: string; workspaceRole?: Role | null; query?: unknown }): string | null | undefined => {
    const wantsAll = (request.query as { scope?: string } | undefined)?.scope === 'platform';
    // Asking is not enough — the workspace must actually BE the platform.
    return wantsAll && request.workspaceRole === 'platform' ? undefined : ws(request);
  };

  // -------------------------------------------------------------------------
  // Session. Who is this visitor, and which dashboard is theirs?
  // -------------------------------------------------------------------------

  app.get('/api/session', async (request) => {
    const r = request as unknown as { workspaceId: string; workspaceRole: Role | null };
    return {
      workspaceId: r.workspaceId,
      role: r.workspaceRole,
      // Switching roles is a DEMO capability, plainly labelled as one. On a real
      // deployment your role is a property of your account and does not change
      // because you clicked something.
      canSwitchRole: config.isDemo,
    };
  });

  app.post('/api/session/role', async (request, reply) => {
    const r = request as unknown as { workspaceId: string; workspaceRole: Role | null };
    const wanted = (request.body as { role?: string } | undefined)?.role ?? '';
    if (!(ROLES as string[]).includes(wanted)) {
      return reply.code(400).send({ error: 'bad_role', message: `Role must be one of ${ROLES.join(', ')}.` });
    }
    if (r.workspaceRole && !config.isDemo) {
      return reply.code(409).send({
        error: 'role_fixed',
        message: 'Your role is part of your account and cannot be changed here.',
      });
    }
    const updated = setWorkspaceRole(r.workspaceId, wanted as Role);
    record({
      actor: `workspace:${r.workspaceId}`,
      action: r.workspaceRole ? 'session.role_switched' : 'session.role_chosen',
      subjectId: r.workspaceId, outcome: 'ok',
      detail: { from: r.workspaceRole, to: wanted, demo: config.isDemo },
      workspaceId: r.workspaceId,
    });
    return updated;
  });

  app.get('/health', async () => ({ ok: true, service: 'kirana', razorpay: config.razorpay.configured }));

  // ---------------------------------------------------------------------------
  // Console API
  // ---------------------------------------------------------------------------

  app.get('/api/merchants', async (request) =>
    listMerchants(scopeFor(request as never)).map((m) => {
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
    // Crawling is expensive for us and for the shop being read.
    const limited = rateLimit(`ingest:${request.ip || 'unknown'}`, 10, 60_000);
    if (!limited.ok) {
      return reply.code(429).send({ error: 'rate_limited', message: `Too many ingestions. Retry in ${Math.ceil(limited.retryAfterMs / 1000)}s.` });
    }
    try {
      const report = await ingestStorefront(body.url, { workspaceId: ws(request as never) });
      enforceMerchantCap();
      const merchant = getMerchant(report.merchantId)!;
      return {
        ...report,
        merchant,
        mcpUrl: `${config.publicOrigin || `http://localhost:${config.port}`}/mcp/${merchant.publicId || merchant.slug}`,
      };
    } catch (err) {
      if (err instanceof IngestError) return reply.code(422).send({ error: err.message, origin: err.origin });
      request.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get('/api/merchants/:slug/products', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const m = getMerchant(slug, ws(request as never));
    if (!m) return reply.code(404).send({ error: 'merchant not found' });
    const q = (request.query as { q?: string }).q;
    return searchCatalog(m.id, { query: q, limit: 100 }).map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, priceFormatted: formatInr(v.priceMinor) })),
    }));
  });

  app.get('/api/audit', async (request) => {
    const { subject, limit } = request.query as { subject?: string; limit?: string };
    return subject ? forSubject(subject) : auditList(Number(limit ?? 200), scopeFor(request as never));
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

  app.get('/api/orders', async (request) =>
    listOrders(100, scopeFor(request as never)).map((o) => ({
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

  app.get('/api/agents', async (request) =>
    listAgents(scopeFor(request as never)).map((a) => ({ ...a, perOrderCap: formatInr(a.perOrderCapMinor), dailyCap: formatInr(a.dailyCapMinor) })),
  );

  app.post('/api/agents/:id/caps', async (request, reply) => {
    const { id } = request.params as { id: string };
    const b = request.body as { perOrderMinor?: number; dailyMinor?: number };
    try {
      const updated = setAgentCaps(id, Number(b.perOrderMinor), Number(b.dailyMinor));
      return updated ?? reply.code(404).send({ error: 'not_found' });
    } catch (err) {
      return reply.code(409).send({ error: 'unverified_agent', message: (err as Error).message });
    }
  });

  app.post('/api/agents/:id/key', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { label?: string; rotate?: boolean } | undefined;
    let issued;
    try {
      issued = issueAgentKey(id, body?.label ?? id, 'console', { rotate: body?.rotate === true });
    } catch (err) {
      return reply.code(409).send({ error: 'already_keyed', message: (err as Error).message });
    }
    const { agent, apiKey } = issued;
    return {
      agent,
      apiKey,
      note: 'Copy this now — only its hash is stored, so it cannot be shown again.',
      usage: 'Send it as the x-kirana-agent-key header on the MCP endpoint.',
    };
  });

  // Manual sweep, for the console button and for a demo with no tunnel.
  app.post('/api/reconcile', async () => reconcile({ minAgeMs: 0 }));

  app.get('/api/system', async () => ({
    demo: config.isDemo,
    killSwitch: {
      engaged: killSwitchActive(),
      reason: KILL_SWITCH.reason,
      releasesAt: KILL_SWITCH.releasesAt ? new Date(KILL_SWITCH.releasesAt).toISOString() : null,
    },
    gateway: circuitState(),
    razorpay: { configured: config.razorpay.configured, mode: 'test' },
  }));

  app.post('/api/system/kill-switch', async (request) => {
    const b = request.body as { engage?: boolean; reason?: string };
    // On the sandbox the stop button releases itself, so it can be demonstrated
    // without one visitor freezing the demo for everyone after them.
    if (b.engage) engageKillSwitch(b.reason ?? 'stopped from the console', config.isDemo ? config.demoKillSwitchMinutes * 60_000 : 0);
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

  app.post('/webhooks/razorpay', async (request, reply) => {
    const secret = config.razorpay.webhookSecret;
    const signature = String(request.headers['x-razorpay-signature'] ?? '');
    const raw = (request as unknown as { rawBody?: string }).rawBody ?? '';

    if (secret) {
      const expected = createHmac('sha256', secret).update(raw).digest('hex');
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      const valid = a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
      if (!valid) {
        record({
          actor: 'razorpay:webhook', action: 'webhook.rejected', subjectId: null, outcome: 'blocked',
          detail: { reason: 'signature did not match', signaturePresent: signature.length > 0, bodyBytes: raw.length },
        });
        return reply.code(400).send({ error: 'invalid signature' });
      }
    } else if (!config.trustLocalWebhooks) {
      // Publicly reachable and unable to verify: refuse. Accepting unsigned
      // "payment captured" events from the open internet would let anyone mark
      // any order paid. The reconciler settles these orders safely anyway.
      record({
        actor: 'razorpay:webhook', action: 'webhook.refused', subjectId: null, outcome: 'blocked',
        detail: { reason: 'RAZORPAY_WEBHOOK_SECRET is not set; unsigned webhooks are refused unless KIRANA_TRUST_LOCAL_WEBHOOKS=true' },
      });
      return reply.code(503).send({ error: 'webhook verification is not configured on this server' });
    } else {
      // Local-only development: allowed, but never silently.
      record({
        actor: 'razorpay:webhook', action: 'webhook.unverified', subjectId: null, outcome: 'blocked',
        detail: { reason: 'RAZORPAY_WEBHOOK_SECRET is not set (local development only)' },
      });
    }

    const body = request.body as {
      event?: string;
      payload?: { payment?: { entity?: Record<string, unknown> }; payment_link?: { entity?: Record<string, unknown> } };
    };
    const event = body.event ?? 'unknown';
    const payment = body.payload?.payment?.entity;
    const link = body.payload?.payment_link?.entity;

    if ((event === 'payment.captured' || event === 'payment_link.paid') && payment) {
      settleOrder({
        razorpayOrderId: (payment.order_id as string) ?? undefined,
        referenceId: (link?.reference_id as string) ?? undefined,
        paymentId: String(payment.id),
        status: 'paid',
        amountMinor: typeof payment.amount === 'number' ? payment.amount : undefined,
        currency: typeof payment.currency === 'string' ? payment.currency : undefined,
      });
    } else if (event === 'payment.failed' && payment) {
      settleOrder({
        razorpayOrderId: (payment.order_id as string) ?? undefined,
        referenceId: (link?.reference_id as string) ?? undefined,
        paymentId: String(payment.id),
        status: 'failed',
        failureReason: `${String(payment.error_code ?? 'failed')}: ${String(payment.error_description ?? '')}`,
      });
    } else {
      record({ actor: 'razorpay:webhook', action: 'webhook.ignored', subjectId: null, outcome: 'ok', detail: { event } });
    }

    // Always 200 on a verified webhook, even for events we ignore: a non-2xx
    // makes Razorpay retry, and retrying something we deliberately skipped is
    // noise, not safety.
    return { ok: true, event };
  });

  // -------------------------------------------------------------------------
  // MCP endpoint, one per merchant. This is the address a buyer agent talks to.
  //
  // Stateless: a fresh server and transport per request. There is no session
  // state worth keeping between calls, and statelessness means a dropped tunnel
  // or a restarted process never strands a buyer agent mid-conversation.
  // -------------------------------------------------------------------------

  app.all('/mcp/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const merchant = getMerchantForMcp(slug);
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

    const agentId = (request as unknown as { agentId?: string | null }).agentId ?? null;
    const identityProven = (request as unknown as { identityProven?: boolean }).identityProven === true;
    // Register on FIRST CONTACT, not on first purchase. An agent that has only
    // browsed is still an agent the merchant should be able to see and cap.
    ensureAgent(agentId, undefined, merchant.workspaceId);
    const server = buildMcpServer(merchant, agentId, identityProven);
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
  const bundle = loadBundle(webDist);

  if (bundle.index) {
    app.log.info(`console bundle       ${bundle.count} files, ${(bundle.bytes / 1024).toFixed(0)} KB, served from memory`);
    app.setNotFoundHandler((request, reply) => {
      let decoded = request.url;
      try { decoded = decodeURIComponent(request.url); } catch { /* keep raw */ }
      if (/^\/+(api|mcp|webhooks)\b/i.test(decoded)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const asset = lookup(bundle, request.url) ?? bundle.index!;
      return reply
        .type(asset.contentType)
        .header('cache-control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .send(asset.body);
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      let decoded = request.url;
      try { decoded = decodeURIComponent(request.url); } catch { /* keep raw */ }
      if (/^\/+(api|mcp|webhooks)\b/i.test(decoded)) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.code(404).send({
        service: 'kirana',
        note: 'Console not built yet. Run `npm run build:web` from the repo root, or `npm run dev:web` for live reload on port 5173.',
      });
    });
  }

  return app;
}
