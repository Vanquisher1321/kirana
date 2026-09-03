import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './lib/config.ts';
import { ingestStorefront, IngestError } from './catalog/ingest.ts';
import { getMerchant, getMerchantForMcp, listMerchants, latestRun, searchCatalog } from './catalog/store.ts';
import { buildMcpServer } from './mcp/server.ts';
import { list as auditList, verify as auditVerify, forSubject, record, workspaceRef } from './audit/ledger.ts';
import { formatInr } from './lib/money.ts';
import { listPendingConsents, approveConsent, rejectConsent, revokeConsent, getConsent, consentWorkspace, ConsentError } from './checkout/consent.ts';
import { getQuote } from './checkout/quote.ts';
import { listOrders, getOrder, orderWorkspace, settleOrder } from './checkout/checkout.ts';
import { reconcile } from './checkout/reconcile.ts';
import { listAgents, getAgent, setAgentCaps, issueAgentKey, agentForKey, agentWorkspace, ensureAgent } from './checkout/agents.ts';
import { secretEquals, rateLimit } from './lib/security.ts';
import { KILL_SWITCH, engageKillSwitch, releaseKillSwitch, killSwitchActive } from './checkout/guard.ts';
import { enforceMerchantCap } from './lib/selfheal.ts';
import { COOKIE, ROLES, cookieHeader, createWorkspace, getWorkspace, readCookie, setFullAccess, setWorkspaceRole, touchWorkspace, type Role } from './lib/workspace.ts';
import { circuitState } from './razorpay/client.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadBundle, lookup } from './lib/staticfiles.ts';

export function buildApp(): FastifyInstance {
  // Trust EXACTLY the immediate peer (hop 0) -- the proxy we are actually
  // behind -- and nothing further up. `trustProxy: true` would trust the whole
  // X-Forwarded-For chain, which the client writes, so any caller could hand
  // itself a fresh IP per request and every per-IP rate limit would be
  // decorative. With no proxy in front (a local run) request.ip is already the
  // real peer, so nothing is trusted at all.
  const trustedProxyHops = config.publicOrigin ? (_address: string, hop: number) => hop === 0 : false;
    const serverOptions: FastifyServerOptions = {
      // Two lines per request buries every real event under thousands of 200s
      // -- and the deploy log is where you look when something is actually
      // wrong, on camera, with minutes to spare. Fastify's own request logging
      // is off and the onResponse hook below logs what is worth reading
      // instead. Fastify 5 deprecates the top-level flag in favour of a full
      // logController object; the flag still works and a partial controller
      // does not typecheck, so this stays until the v6 upgrade forces it.
      disableRequestLogging: true,
      logger: process.env.KIRANA_QUIET
        ? false
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,reqId,responseTime' } } },
      bodyLimit: 2 * 1024 * 1024,
      // Behind Render's edge every request arrives from the same socket peer,
      // so `request.ip` was identical for every visitor and each per-IP rate
      // limit became one instance-wide bucket: one script looping /api/ingest
      // 429s everybody. Trust exactly ONE hop -- the proxy we are actually
      // behind -- never the whole X-Forwarded-For chain, which the client
      // controls.
      trustProxy: trustedProxyHops,
    };
    const app = Fastify(serverOptions);

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
      const req = request as unknown as {
        workspaceId: string; workspaceRole: Role | null; fullAccess: boolean; operator: boolean;
      };
      req.workspaceId = ws.id;
      req.workspaceRole = ws.role;
      req.fullAccess = ws.fullAccess;
      req.operator = false;

      const header = String(request.headers.authorization ?? '');
      const presented = header.startsWith('Bearer ') ? header.slice(7) : String(request.headers['x-kirana-console'] ?? '');
      const wantsPlatform = (request.query as { scope?: string } | undefined)?.scope === 'platform';

      // The operator token is the deploy secret. Whoever holds it is the person
      // running this instance, not a visitor -- so it carries platform reach.
      // (An empty configured token must never match an empty header.)
      const isOperator = config.consoleToken.length > 0 && secretEquals(presented, config.consoleToken);
      if (isOperator) { req.fullAccess = true; req.operator = true; }

      // A sandbox is meant to be driven, not admired. Test credentials only.
      if (config.isDemo) return;

      // Cross-tenant reads are privileged even though ordinary reads are open.
      if (wantsPlatform && !isOperator) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'The platform view reads across every workspace and needs the operator token.',
        });
      }

      if (isOperator) return;

      // Locked: reading stays open so the console is legible, but every
      // endpoint that spends, approves, ingests, pauses or issues a key is a
      // POST -- so the verb is very nearly the whole distinction.
      if (request.method === 'GET') return;

      // The exception: /api/session/* only ever writes to the caller's OWN
      // workspace -- which dashboard they get, and reviewer mode, which is
      // demo-only and refused in its own handler. Requiring the operator token
      // here meant a first-time visitor to a locked deployment got 401 from
      // the onboarding screen and could never choose a role at all: the
      // console was unusable by exactly the people it is for.
      if (route.startsWith('/api/session')) return;

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
      // A self-asserted name becomes a primary key in `agents` and the actor
      // string on audit rows the merchant reads, so it cannot be arbitrary
      // header bytes: unbounded and unvalidated, it is both unbounded row
      // growth and attacker-chosen text written into somebody else's console.
      // Anything that is not a plausible agent name is simply ignored, which
      // leaves the caller anonymous rather than failing their request.
      const rawLabel = String(request.headers['x-kirana-agent'] ?? '').trim();
      const label = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,47}$/.test(rawLabel) ? rawLabel : '';
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
  const scopeFor = (request: {
    workspaceId?: string; workspaceRole?: Role | null; fullAccess?: boolean; operator?: boolean; query?: unknown;
  }): string | null | undefined => {
    // A caller holding the deploy secret is running this instance, not visiting
    // it. Making the operator append ?scope=platform to every call is a trap:
    // the endpoint would answer 200 with an empty list and look like data loss.
    if (request.operator) return undefined;
    const wantsAll = (request.query as { scope?: string } | undefined)?.scope === 'platform';
    // Asking is not enough — the workspace must BE the platform, or have
    // deliberately turned on reviewer mode. Note this is READ reach only;
    // acting on another tenant's records needs the operator token (see owns).
    const mayReadAll = request.workspaceRole === 'platform' || request.fullAccess === true;
    return wantsAll && mayReadAll ? undefined : ws(request);
  };

  /** Shops only: `?scope=directory` is the public storefront index. */
  const directoryScope = (request: {
    workspaceId?: string; workspaceRole?: Role | null; fullAccess?: boolean; operator?: boolean; query?: unknown;
  }): string | null | undefined =>
    (request.query as { scope?: string } | undefined)?.scope === 'directory' ? undefined : scopeFor(request);

  /**
   * May this caller touch a record that belongs to `ownerWorkspace`?
   *
   * Reads scope themselves (a filtered list simply omits other tenants). But a
   * route that takes an ID -- approve, reject, revoke, rotate a key -- has no
   * list to filter: the ID IS the query. Without this check any visitor could
   * approve another visitor's spending, which is the entire human half of the
   * loop, bypassed by guessing an ID.
   *
   * Cross-tenant access is allowed only for the platform persona and for
   * reviewer mode, matching `scopeFor`. Everyone else gets a 404 rather than a
   * 403, so the endpoint does not confirm that the ID exists.
   */
  /**
   * READING across tenants and ACTING across tenants are different powers.
   *
   * On the sandbox a visitor may hand themselves the platform role or reviewer
   * mode -- both are one unauthenticated POST, deliberately, because judges
   * need to see all three consoles. That is fine for a read view of a test-mode
   * instance. It is NOT a licence to approve, reject or revoke somebody else's
   * spending, which is exactly what happens if the same predicate guards both:
   * one POST to /api/session/role and the entire human-in-the-loop guarantee
   * belongs to whoever asked for it last.
   *
   * So only the operator token -- the deploy secret, which no visitor has --
   * may act across tenants. Everyone else acts on their own workspace and reads
   * as widely as their persona allows.
   */
  const mayActCrossTenant = (request: { operator?: boolean }) => request.operator === true;

  const owns = (
    request: { workspaceId?: string; operator?: boolean },
    ownerWorkspace: string | null,
  ): boolean => {
    // NOT relaxed in demo mode. The open sandbox is exactly where strangers
    // share one instance, so it is exactly where one visitor approving
    // another visitor's spending would matter most.
    if (mayActCrossTenant(request)) return true;
    return ownerWorkspace !== null && ownerWorkspace === ws(request);
  };

  /**
   * The same check, for records that hang off a SHOP.
   *
   * Quotes, approvals and orders inherit their workspace from the merchant,
   * and the shop this server seeds on boot belongs to nobody. Under a strict
   * `owner === me` rule that made it unusable: an agent shopping the demo shop
   * asks for permission and no human on earth can grant it. Verified on the
   * deployed instance -- the approval queue read 0 and the approve button
   * answered 404, which is the pitch dead-ending on its own central claim.
   *
   * A shared demo shop has a shared approval queue; that is what a sandbox is,
   * and it is bounded by the same test credentials and hard caps as everything
   * else. The guarantee that matters is untouched: a shop a visitor CONNECTED
   * is theirs, and no other visitor can act on it.
   *
   * This is deliberately NOT the rule for agents. An agent row gets a null
   * workspace by accident -- `ensureAgent` is called without one from the
   * anonymous MCP path -- rather than by being the instance's own. Treating
   * that null as "shared" let one visitor raise another's spending caps, which
   * a test caught the moment the blanket version went in.
   */
  const ownsViaShop = (
    request: { workspaceId?: string; operator?: boolean },
    ownerWorkspace: string | null,
  ): boolean => (ownerWorkspace === null ? true : owns(request, ownerWorkspace));

  /**
   * Who approved this, for the audit trail.
   *
   * The caller used to be able to name themselves, and both the console and the
   * server defaulted that name to a hardcoded 'om' -- so on a public sandbox
   * every stranger's approval was recorded as having been granted by the person
   * who built it, and any caller could have written any name they liked into
   * the ledger. The audit trail is the centrepiece of this project's argument;
   * an attributable-to-anyone field is not evidence.
   *
   * Attribution comes from the session instead: the operator when the deploy
   * secret was presented, otherwise the caller's own one-way workspace
   * reference.
   */
  const approver = (request: { workspaceId?: string; operator?: boolean }): string => {
    if (request.operator) return 'human:operator';
    const w = ws(request);
    return w ? `human:${workspaceRef(w)}` : 'human:anonymous';
  };

  // -------------------------------------------------------------------------
  // Session. Who is this visitor, and which dashboard is theirs?
  // -------------------------------------------------------------------------

  app.get('/api/session', async (request) => {
    const r = request as unknown as { workspaceId: string; workspaceRole: Role | null; fullAccess: boolean };
    return {
      workspaceId: r.workspaceId,
      role: r.workspaceRole,
      fullAccess: r.fullAccess,
      // Reviewer mode exists only on the sandbox. On a real deployment your
      // role is a property of your account and there is nothing to switch.
      canEnableFullAccess: config.isDemo,
    };
  });

  /**
   * Reviewer mode.
   *
   * The default experience is deliberately narrow — one account, one console —
   * because that is what a real merchant or shopper gets. Someone evaluating
   * the product needs to see all three, so they turn this on explicitly and it
   * is labelled as what it is, rather than every visitor getting a tab bar no
   * real user would ever have.
   */
  app.post('/api/session/full-access', async (request, reply) => {
    if (!config.isDemo) {
      return reply.code(403).send({
        error: 'not_available',
        message: 'Reviewer mode only exists on the public sandbox.',
      });
    }
    const r = request as unknown as { workspaceId: string };
    const enabled = (request.body as { enabled?: boolean } | undefined)?.enabled !== false;
    const updated = setFullAccess(r.workspaceId, enabled);
    record({
      actor: workspaceRef(r.workspaceId), action: enabled ? 'session.reviewer_mode_on' : 'session.reviewer_mode_off',
      subjectId: null, outcome: 'ok', detail: {}, workspaceId: r.workspaceId,
    });
    return updated;
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
      actor: workspaceRef(r.workspaceId),
      action: r.workspaceRole ? 'session.role_switched' : 'session.role_chosen',
      subjectId: null, outcome: 'ok',
      detail: { from: r.workspaceRole, to: wanted, demo: config.isDemo },
      workspaceId: r.workspaceId,
    });
    return updated;
  });

  /**
   * Fastify's default handler returns the thrown error's message and code, so
   * an unhandled fault answers with engine internals. Every deliberate refusal
   * in this app is an explicit reply; anything that reaches here is a bug, and
   * a bug tells the operator's log, not the caller.
   */
  app.setErrorHandler((err: unknown, request, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // A 4xx from the framework is about the caller's own request (a malformed
    // body, an unsupported content type) and telling them is the point.
    if (status < 500) return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    request.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Nothing was charged.' });
  });

  /**
   * Last line of defence: a workspace id must never leave in a response body.
   *
   * A workspace id is the session cookie. It has now escaped twice -- once into
   * the audit trail, once into the public shop directory -- and both times the
   * mechanism was a field riding along in an object somebody serialised without
   * reading. Allowlists at each route are the fix; this is the net under it,
   * because the next leak will be in a route nobody is thinking about today.
   *
   * `/api/session*` is exempt: those routes return the CALLER's own id, which
   * they already hold in their own cookie. Everything else that emits one is a
   * bug, so it is redacted and logged loudly rather than quietly stripped.
   */
  const WS_TOKEN = /ws_[A-Za-z0-9_-]{16,}/g;
  app.addHook('onSend', async (request, reply, payload) => {
    const route = request.routeOptions?.url ?? '';
    if (route.startsWith('/api/session')) return payload;
    if (typeof payload !== 'string' || !payload.includes('ws_')) return payload;
    const own = ws(request as never);
    const stray = (payload.match(WS_TOKEN) ?? []).filter((t) => t !== own);
    if (stray.length === 0) return payload;
    request.log.error(
      `BUG: ${route} tried to return ${stray.length} workspace id(s) in its body; redacted before sending.`,
    );
    return payload.replace(WS_TOKEN, (t) => (t === own ? t : 'ws_redacted'));
  });

  /**
   * Log what is worth reading: writes, agent traffic, and anything that failed.
   * A GET that returned 2xx on the console's own polling loop is noise.
   */
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? request.url;
    const dull = request.method === 'GET' && reply.statusCode < 400 && route.startsWith('/api/');
    if (dull || route === '/health') return;
    request.log.info(
      `${request.method} ${route} -> ${reply.statusCode}`,
    );
  });

  /**
   * The public shape of a shop. Built field by field, on purpose.
   *
   * This used to be `{ ...m }`, and a Merchant row carries `workspaceId` --
   * which IS the session cookie. So the public shop directory published every
   * merchant's session: a stranger with no cookie read
   * `GET /api/merchants?scope=directory`, took an id, set it as `kirana_ws`,
   * and was that merchant. Reproduced end to end before this fix.
   *
   * That is the second time a workspace id escaped into readable content --
   * the audit trail was the first. A spread is what did it both times: it
   * exports whatever the row happens to hold, including fields added later by
   * someone who never looked at this line. An allowlist cannot do that.
   */
  const publicMerchant = (m: {
    id: string; slug: string; name: string; originUrl: string; publicId?: string | null;
    platform: string; currency: string; policies: unknown; ingestedAt: string;
  }) => {
    const run = latestRun(m.id);
    return {
      id: m.id,
      slug: m.slug,
      name: m.name,
      originUrl: m.originUrl,
      publicId: m.publicId ?? null,
      platform: m.platform,
      currency: m.currency,
      policies: m.policies,
      ingestedAt: m.ingestedAt,
      products: run ? Number(run.product_count) : 0,
      variants: run ? Number(run.variant_count) : 0,
      adapter: run ? String(run.adapter) : null,
      usedLlm: run ? Number(run.used_llm) === 1 : false,
      warnings: run ? (JSON.parse(String(run.warnings)) as string[]) : [],
      durationMs: run ? Number(run.duration_ms) : 0,
      // public_id, not slug: the slug comes from the shop's hostname and is
      // unique only within a workspace, so anyone re-ingesting the same shop
      // made the published URL ambiguous and every agent using it got a 404.
      mcpUrl: `${config.publicOrigin || `http://localhost:${config.port}`}/mcp/${m.publicId || m.slug}`,
    };
  };

  app.get('/health', async () => ({ ok: true, service: 'kirana', razorpay: config.razorpay.configured }));

  // ---------------------------------------------------------------------------
  // Console API
  // ---------------------------------------------------------------------------

  /**
   * Shops are the one thing that is deliberately PUBLIC.
   *
   * The whole premise is that any agent can shop any merchant, and the MCP
   * endpoint is already open to the world -- so hiding the directory from a
   * shopper would hide nothing while breaking discovery. Everything derived
   * from a shop (its orders, approvals, agents, audit) stays scoped.
   */
  app.get('/api/merchants', async (request) =>
    listMerchants(directoryScope(request as never)).map(publicMerchant),
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
      enforceMerchantCap(ws(request as never));
      const merchant = getMerchant(report.merchantId)!;
      const shop = publicMerchant(merchant);
      return { ...report, merchant: shop, mcpUrl: shop.mcpUrl };
    } catch (err) {
      if (err instanceof IngestError) return reply.code(422).send({ error: err.message, origin: err.origin });
      // IngestError messages are written for humans and are safe to return.
      // Anything else is an internal fault: log it, do not narrate it.
      request.log.error(err);
      return reply.code(500).send({ error: 'ingest_failed', message: 'The shop could not be read. Nothing was saved.' });
    }
  });

  app.get('/api/merchants/:slug/products', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    // Your own shop, or the instance's shared demo shop. A catalogue is public
    // data the MCP endpoint already serves to any agent on earth, so hiding it
    // from the console that is meant to display it helps nobody.
    const m = getMerchant(slug, ws(request as never)) ?? getMerchant(slug, null);
    if (!m) return reply.code(404).send({ error: 'merchant not found' });
    const q = (request.query as { q?: string }).q;
    return searchCatalog(m.id, { query: q, limit: 100 }).map((p) => ({
      ...p,
      variants: p.variants.map((v) => ({ ...v, priceFormatted: formatInr(v.priceMinor) })),
    }));
  });

  app.get('/api/audit', async (request, reply) => {
    // Bounded by `limit`, but a thousand rows a call is still worth a budget.
    const limited = rateLimit(`audit:${request.ip || 'unknown'}`, 60, 60_000);
    if (!limited.ok) {
      return reply.code(429).header('retry-after', Math.ceil(limited.retryAfterMs / 1000))
        .send({ error: 'rate_limited', message: 'Too many audit reads. Try again shortly.' });
    }
    const { subject, limit: rawLimit } = request.query as { subject?: string; limit?: string };
    // `?limit=abc` used to reach SQLite and come back as
    // {"code":"ERR_SQLITE_ERROR","message":"datatype mismatch"} -- engine
    // detail, from a 500, on an unauthenticated route.
    const parsed = Number(rawLimit);
    const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 200;
    return subject
      ? forSubject(subject, scopeFor(request as never))
      : auditList(limit, scopeFor(request as never));
  });

  /**
   * The one endpoint whose cost grows without bound.
   *
   * verify() re-reads and re-hashes EVERY row in the audit log, so it is
   * O(rows ever written) per call and gets slower for the life of the
   * instance. It is also the most attractive thing on the server to hammer:
   * unauthenticated, cheap to ask for, expensive to answer. Keyed on the
   * address rather than the workspace, because a workspace is minted free on
   * any cookie-less request and would hand an attacker a fresh bucket per
   * call.
   */
  app.get('/api/audit/verify', async (request, reply) => {
    const limited = rateLimit(`verify:${request.ip || 'unknown'}`, 12, 60_000);
    if (!limited.ok) {
      return reply.code(429).header('retry-after', Math.ceil(limited.retryAfterMs / 1000))
        .send({ error: 'rate_limited', message: 'Verifying the chain is expensive. Try again shortly.' });
    }
    return auditVerify();
  });

  // -------------------------------------------------------------------------
  // Approvals — the human half of the loop.
  // -------------------------------------------------------------------------

  /**
   * Approvals do not widen for a self-selected role.
   *
   * `scopeFor` lets a visitor who picked the Razorpay persona READ across
   * tenants, which is fine for orders and shops. It is not fine here: a
   * pending approval published its `quoteId` and `consentId`, and that pair is
   * a CAPABILITY. The open /mcp endpoint accepts exactly that pair plus a
   * self-asserted agent name, so a stranger could take another tenant's
   * approval, wait for their human to click yes, and spend it -- the
   * human-in-the-loop guarantee bypassed across tenants, using two
   * unauthenticated requests.
   *
   * Reading every tenant's queue now needs the operator token, like acting on
   * one does. A visitor still sees their own, plus the shared demo shop's.
   */
  app.get('/api/approvals', async (request) =>
    listPendingConsents(
      (request as never as { operator?: boolean }).operator ? undefined : ws(request as never),
    ).map((c) => {
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
    if (!ownsViaShop(request as never, consentWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
    try { return approveConsent(id, approver(request as never)); }
    catch (err) {
      if (err instanceof ConsentError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/api/approvals/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownsViaShop(request as never, consentWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
    return rejectConsent(id, approver(request as never));
  });

  app.post('/api/approvals/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownsViaShop(request as never, consentWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
    return revokeConsent(id, approver(request as never));
  });

  app.get('/api/approvals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!ownsViaShop(request as never, consentWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
    const c = getConsent(id);
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const q = getQuote(c.quoteId);
    // The quote's HMAC signature is server-side evidence, not something a
    // reader needs. It is re-derived at payment time from the stored row.
    return {
      ...c,
      capFormatted: formatInr(c.capMinor),
      quote: q && {
        id: q.id, total: formatInr(q.totalMinor), totalMinor: q.totalMinor,
        currency: q.currency, expiresAt: q.expiresAt, status: q.status,
        lines: q.lines,
      },
    };
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
    if (!ownsViaShop(request as never, orderWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
    const o = getOrder(id);
    if (!o) return reply.code(404).send({ error: 'not_found' });
    // Allowlisted, not spread. `SELECT *` on orders carries workspace_id --
    // the same shape that leaked a session id twice already -- and it also
    // published quote_id and consent_id, which together are a capability the
    // open MCP endpoint will spend.
    return {
      id: String(o.id),
      status: String(o.status),
      amountMinor: Number(o.amount_minor),
      amountFormatted: formatInr(Number(o.amount_minor)),
      currency: String(o.currency),
      razorpayOrderId: (o.razorpay_order_id as string | null) ?? null,
      razorpayPaymentId: (o.razorpay_payment_id as string | null) ?? null,
      failureReason: (o.failure_reason as string | null) ?? null,
      agentId: (o.agent_id as string | null) ?? null,
      createdAt: String(o.created_at),
      updatedAt: String(o.updated_at),
      audit: forSubject(id, scopeFor(request as never)),
    };
  });

  app.get('/api/agents', async (request) =>
    listAgents(scopeFor(request as never)).map((a) => ({ ...a, perOrderCap: formatInr(a.perOrderCapMinor), dailyCap: formatInr(a.dailyCapMinor) })),
  );

  app.post('/api/agents/:id/caps', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (getAgent(id) && !owns(request as never, agentWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
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
    // An agent that does not exist yet is being created by this very call --
    // there is nothing to own. One that exists must belong to the caller.
    if (getAgent(id) && !owns(request as never, agentWorkspace(id))) return reply.code(404).send({ error: 'not_found' });
    const body = request.body as { label?: string; rotate?: boolean } | undefined;
    let issued;
    try {
      issued = issueAgentKey(id, body?.label ?? id, 'console', { rotate: body?.rotate === true, workspaceId: ws(request as never) });
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
  //
  // Rate-limited because on the open sandbox this is the one button a visitor
  // can press that costs someone ELSE money: each sweep polls Razorpay once per
  // pending order, so a loop here is an amplifier pointed at the gateway.
  app.post('/api/reconcile', async (request, reply) => {
    // Keyed on the ADDRESS, not the workspace: a workspace is minted free on
    // any cookie-less request, so the old key gave an attacker a fresh bucket
    // per request. Measured: 30 cookie-less calls, 30 accepted.
    const limited = rateLimit(`reconcile:${request.ip || 'unknown'}`, 6, 60_000);
    if (!limited.ok) {
      return reply.code(429).header('retry-after', Math.ceil(limited.retryAfterMs / 1000))
        .send({ error: 'rate_limited', message: 'Reconciling too often. Try again shortly.' });
    }
    return reconcile({ minAgeMs: 0 });
  });

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
      // Attributed to a workspace: on the open sandbox the stop button is
      // global, so the ledger must say WHICH visitor pressed it.
      actor: `human:console:${(() => { const w = ws(request as never); return w ? workspaceRef(w) : 'anonymous'; })()}`,
      action: b.engage ? 'kill_switch.engaged' : 'kill_switch.released',
      subjectId: null, outcome: 'ok',
      detail: { reason: b.reason ?? null, autoReleasesAt: KILL_SWITCH.releasesAt || null },
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
