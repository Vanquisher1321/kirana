/**
 * Standing authorisation must never become "the agent can approve itself".
 *
 * Every test here is a way that could happen by accident. The one that matters
 * most is `an unverified agent is never auto-approved`: identity arrives either
 * as a key the caller proved, or as a header anyone can copy, and a standing
 * rule is the largest prize in the system for someone who learns a trusted
 * agent's name.
 *
 * The other shape worth stating: every refusal must fall back to ASKING a
 * human, never to failing the request. A rule that has expired, been revoked,
 * or run out of headroom leaves an ordinary pending approval behind.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-standing-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'd'.repeat(64);
process.env.KIRANA_QUIET = '1';

const { db } = await import('../lib/db.ts');
const { requestConsent, getConsent } = await import('./consent.ts');
const { ensureAgent, issueAgentKey } = await import('./agents.ts');
const {
  createStandingRule, revokeStandingRule, listStandingRules,
  matchStandingRule, committedTodayMinor, StandingError,
} = await import('./standing.ts');
const { engageKillSwitch, releaseKillSwitch } = await import('./guard.ts');
const { createWorkspace, rememberDelivery } = await import('../lib/workspace.ts');
import { SAMPLE_DELIVERY } from '../__fixtures__/delivery.ts';

const RUPEE = 100;
let verifiedId = '';
let unverifiedId = '';
/**
 * The person whose rule it is, and therefore whose address it ships to.
 *
 * A standing rule is a human's answer given in advance, and an answer that
 * names a ceiling but no destination is half of one -- there is nobody to ask
 * at capture time. So these rules have an owner who has saved an address,
 * which is what every rule made from the console has.
 */
let owner = '';

/** A quote row the consent can hang off. The price path is tested elsewhere. */
function fakeQuote(id: string, agentId: string | null) {
  db.prepare(
    `INSERT INTO quotes (id, merchant_id, agent_id, lines, subtotal_minor, shipping_minor, tax_minor,
      total_minor, currency, expires_at, signature, created_at)
     VALUES (?, 'mch_test', ?, '[]', 100, 0, 0, 100, 'INR', ?, 'sig', ?)`,
  ).run(id, agentId, new Date(Date.now() + 600_000).toISOString(), new Date().toISOString());
  return id;
}

before(() => {
  db.prepare(
    `INSERT OR IGNORE INTO merchants (id, slug, name, origin_url, platform, currency, policies, ingested_at)
     VALUES ('mch_test','test','Test Shop','https://example.com','shopify','INR','{}',?)`,
  ).run(new Date().toISOString());

  const v = ensureAgent('trusted-agent', 'Trusted Agent');
  verifiedId = v!.id;
  issueAgentKey(verifiedId, 'Trusted Agent');           // makes it verified
  const u = ensureAgent('drifter', 'Drifter');
  unverifiedId = u!.id;

  owner = createWorkspace('Rule owner').id;
  rememberDelivery(owner, JSON.stringify(SAMPLE_DELIVERY));
});

test('a matching rule auto-grants, on the human who made it', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 2000 * RUPEE, createdBy: 'om',
  });
  const c = requestConsent({
    quoteId: fakeQuote('qte_auto1', verifiedId), agentId: verifiedId,
    capMinor: 300 * RUPEE, scope: 'mch_test', identityProven: true,
  });
  assert.equal(c.status, 'granted');
  assert.equal(c.grantedBy, 'om', 'the grant carries the name of the person whose rule allowed it');
  const stored = getConsent(c.id)!;
  assert.equal(stored.status, 'granted');
  revokeStandingRule(rule.id);
});

test('an unverified agent is never auto-approved, even with a rule naming it', () => {
  // Written straight into the table: createStandingRule refuses this outright,
  // so the only way to reach the matcher with one is to forge the row.
  db.prepare(
    `INSERT INTO standing_rules (id, workspace_id, agent_id, per_order_cap_minor, daily_cap_minor,
      created_by, created_at, expires_at, revoked_at)
     VALUES ('rule_forged', NULL, ?, ?, ?, 'om', ?, ?, NULL)`,
  ).run(unverifiedId, 900 * RUPEE, 9000 * RUPEE, new Date().toISOString(),
        new Date(Date.now() + 86_400_000).toISOString());

  const c = requestConsent({
    quoteId: fakeQuote('qte_unver', unverifiedId), agentId: unverifiedId,
    capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: true,
  });
  assert.equal(c.status, 'pending', 'an unproven identity earns nothing, rule or no rule');
  db.prepare("DELETE FROM standing_rules WHERE id = 'rule_forged'").run();
});

test('claiming a verified name without proving it earns nothing', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 2000 * RUPEE, createdBy: 'om',
  });
  const c = requestConsent({
    quoteId: fakeQuote('qte_spoof', verifiedId), agentId: verifiedId,
    capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: false,   // the header, not the key
  });
  assert.equal(c.status, 'pending');
  revokeStandingRule(rule.id);
});

test('a basket over the per-order ceiling falls back to asking', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 5000 * RUPEE, createdBy: 'om',
  });
  const c = requestConsent({
    quoteId: fakeQuote('qte_over', verifiedId), agentId: verifiedId,
    capMinor: 501 * RUPEE, scope: 'mch_test', identityProven: true,
  });
  assert.equal(c.status, 'pending');
  revokeStandingRule(rule.id);
});

test('many small baskets cannot add up past the daily ceiling', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 400 * RUPEE, dailyCapMinor: 1000 * RUPEE, createdBy: 'om',
  });
  const statuses: string[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push(requestConsent({
      quoteId: fakeQuote(`qte_bulk${i}`, verifiedId), agentId: verifiedId,
      capMinor: 400 * RUPEE, scope: 'mch_test', identityProven: true,
    }).status);
  }
  assert.deepEqual(statuses, ['granted', 'granted', 'pending', 'pending'],
    '400+400 fits under 1000; the third would breach it and must ask a human');
  assert.equal(committedTodayMinor(rule.id), 800 * RUPEE);
  revokeStandingRule(rule.id);
});

test('revoking a rule stops the next request immediately', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 5000 * RUPEE, createdBy: 'om',
  });
  assert.equal(requestConsent({
    quoteId: fakeQuote('qte_before', verifiedId), agentId: verifiedId,
    capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: true,
  }).status, 'granted');

  revokeStandingRule(rule.id, 'om');

  assert.equal(requestConsent({
    quoteId: fakeQuote('qte_after', verifiedId), agentId: verifiedId,
    capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: true,
  }).status, 'pending');
});

test('an expired rule is dead, not merely stale', () => {
  db.prepare(
    `INSERT INTO standing_rules (id, workspace_id, agent_id, per_order_cap_minor, daily_cap_minor,
      created_by, created_at, expires_at, revoked_at)
     VALUES ('rule_expired', NULL, ?, ?, ?, 'om', ?, ?, NULL)`,
  ).run(verifiedId, 900 * RUPEE, 9000 * RUPEE, new Date(Date.now() - 172_800_000).toISOString(),
        new Date(Date.now() - 86_400_000).toISOString());

  const c = requestConsent({
    quoteId: fakeQuote('qte_exp', verifiedId), agentId: verifiedId,
    capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: true,
  });
  assert.equal(c.status, 'pending');
  db.prepare("DELETE FROM standing_rules WHERE id = 'rule_expired'").run();
});

test('the kill switch stops approvals given in advance too', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 5000 * RUPEE, createdBy: 'om',
  });
  engageKillSwitch('test');
  try {
    assert.equal(requestConsent({
      quoteId: fakeQuote('qte_kill', verifiedId), agentId: verifiedId,
      capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: true,
    }).status, 'pending', 'a stopped system approves nothing, including in advance');
  } finally {
    releaseKillSwitch();
  }
  revokeStandingRule(rule.id);
});

test('a rule cannot be created against an agent that never proved itself', () => {
  assert.throws(
    () => createStandingRule({
      workspaceId: owner, agentId: unverifiedId,
      perOrderCapMinor: 100 * RUPEE, dailyCapMinor: 100 * RUPEE, createdBy: 'om',
    }),
    (e: unknown) => e instanceof StandingError && e.code === 'agent_unverified',
  );
});

test('a daily ceiling below the per-order one is refused rather than silently inert', () => {
  assert.throws(
    () => createStandingRule({
      workspaceId: owner, agentId: verifiedId,
      perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 100 * RUPEE, createdBy: 'om',
    }),
    (e: unknown) => e instanceof StandingError && e.code === 'daily_below_order',
  );
});

test('a rule always expires, however long a life it asks for', () => {
  const rule = createStandingRule({
    workspaceId: owner, agentId: verifiedId,
    perOrderCapMinor: 100 * RUPEE, dailyCapMinor: 100 * RUPEE, createdBy: 'om',
    ttlMs: 365 * 24 * 60 * 60 * 1000,
  });
  const life = Date.parse(rule.expiresAt) - Date.parse(rule.createdAt);
  assert.ok(life <= 30 * 24 * 60 * 60 * 1000 + 1000, 'capped at thirty days');
  assert.ok(listStandingRules().some((r) => r.id === rule.id));
  revokeStandingRule(rule.id);
});

test('a rule whose owner never saved an address asks a human instead', () => {
  // The other half of "answered in advance". A ceiling with no destination
  // cannot complete a purchase: there would be nobody present at capture time
  // to say where the parcel goes, and the guard would refuse the charge after
  // the approval had already been spent. Falling back to asking is the same
  // move every other unmet condition here makes -- a reason to refuse is a
  // reason to ask, never a reason to fail.
  const addressless = createWorkspace('No address saved').id;
  const rule = createStandingRule({
    workspaceId: addressless, agentId: verifiedId,
    perOrderCapMinor: 500 * RUPEE, dailyCapMinor: 2000 * RUPEE, createdBy: 'om',
  });
  const c = requestConsent({
    quoteId: fakeQuote('qte_noaddr', verifiedId), agentId: verifiedId,
    capMinor: 100 * RUPEE, scope: 'mch_test', identityProven: true,
  });
  assert.equal(c.status, 'pending', 'no saved address means no silent auto-grant');
  assert.equal(c.delivery, null);
  revokeStandingRule(rule.id);
});

test('matchStandingRule is inert with no rules at all', () => {
  assert.equal(matchStandingRule({ agentId: verifiedId, identityProven: true, capMinor: RUPEE }), null);
});
