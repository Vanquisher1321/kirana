import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, fromMinor, formatInr, MoneyError } from './money.ts';

test('toMinor parses decimal strings exactly', () => {
  assert.equal(toMinor('499.00'), 49900);
  assert.equal(toMinor('499'), 49900);
  assert.equal(toMinor('499.1'), 49910);
  assert.equal(toMinor('0.05'), 5);
  assert.equal(toMinor('1,499.50'), 149950);
  assert.equal(toMinor('₹2,999'), 299900);
  assert.equal(toMinor('Rs. 75.25'), 7525);
});

test('toMinor avoids the float trap', () => {
  // The naive implementation returns 49909.999999999993 here.
  assert.equal(toMinor('499.10'), 49910);
  assert.equal(toMinor('1.15'), 115);
  assert.equal(toMinor('8.20'), 820);
});

test('toMinor rejects junk instead of guessing', () => {
  assert.throws(() => toMinor('abc'), MoneyError);
  assert.throws(() => toMinor(''), MoneyError);
  assert.throws(() => toMinor('12.3.4'), MoneyError);
});

test('fromMinor round-trips', () => {
  for (const v of [0, 5, 100, 49900, 149950, 99999999]) {
    assert.equal(toMinor(fromMinor(v)), v);
  }
});

test('formatInr uses Indian grouping', () => {
  assert.equal(formatInr(49900), '₹499.00');
  assert.equal(formatInr(149950), '₹1,499.50');
  assert.equal(formatInr(1234567890), '₹1,23,45,678.90');
});
