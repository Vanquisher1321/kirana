import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KIRANA_DB = `data/test-ledger-${process.pid}.db`;
const { record, verify, list, forSubject } = await import('./ledger.ts');
const { db } = await import('../lib/db.ts');

test('chain verifies over many appended entries', () => {
  for (let i = 0; i < 25; i++) {
    record({ actor: 'agent:test', action: 'quote.created', subjectId: `q_${i}`, outcome: 'ok', detail: { i } });
  }
  const v = verify();
  assert.equal(v.ok, true);
  assert.equal(v.checked, 25);
});

test('entries are retrievable newest-first and per subject', () => {
  assert.equal(list(5).length, 5);
  assert.equal(forSubject('q_3').length, 1);
});

test('editing a row in place is detected', () => {
  db.exec("UPDATE audit_log SET outcome = 'blocked' WHERE seq = 10");
  const v = verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAtSeq, 10);
  assert.match(v.reason ?? '', /edited after it was written/);
  db.exec("UPDATE audit_log SET outcome = 'ok' WHERE seq = 10");
  assert.equal(verify().ok, true);
});

test('deleting a row is detected', () => {
  db.exec('DELETE FROM audit_log WHERE seq = 12');
  const v = verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAtSeq, 13);
  assert.match(v.reason ?? '', /removed, reordered or inserted/);
});

test('hash input is unambiguous across field boundaries', () => {
  // A space-joined encoding hashes {actor:"a b", action:"c"} identically to
  // {actor:"a", action:"b c"} — content shifts, the chain still verifies.
  record({ actor: 'a b', action: 'c', subjectId: 'boundary', outcome: 'ok' });
  record({ actor: 'a', action: 'b c', subjectId: 'boundary', outcome: 'ok' });
  const rows = forSubject('boundary');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.hash, rows[1]!.hash, 'shifted content must not produce the same digest');
  // Note: an earlier test in this file deliberately deletes a row to prove
  // tamper detection, so the chain is broken by design at this point.
});
