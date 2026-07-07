// Regression test for the MM-quote strike-ordering fix. Runs against the
// compiled dist so it exercises the shipped artifact. `npm test` builds first.
//
// The bug: getSpreadPricing expects strikes in the MM's convention
// (PUT_SPREAD descending [hi,lo]; CALL_SPREAD ascending [lo,hi]). Passing the
// wrong order flips near/far and computes (low_ask - high_bid) — a near-zero,
// ~48x-too-low price. On RFQ 87 that would have produced a $0.11 reserve for a
// spread the MM actually quoted at $5.30. orderSpreadStrikes() enforces the
// convention regardless of the order the client supplied.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orderSpreadStrikes } from '../dist/mmQuote.js';

describe('orderSpreadStrikes — MM strike-ordering convention', () => {
  test('PUT_SPREAD returns [higher, lower] regardless of input order', () => {
    assert.deepEqual(orderSpreadStrikes('PUT_SPREAD', [1650, 1675]), [1675, 1650]);
    assert.deepEqual(orderSpreadStrikes('PUT_SPREAD', [1675, 1650]), [1675, 1650]);
  });

  test('CALL_SPREAD returns [lower, higher] regardless of input order', () => {
    assert.deepEqual(orderSpreadStrikes('CALL_SPREAD', [1675, 1650]), [1650, 1675]);
    assert.deepEqual(orderSpreadStrikes('CALL_SPREAD', [1650, 1675]), [1650, 1675]);
  });

  test('PUT and CALL flies/condors follow the PUT/CALL prefix rule', () => {
    // Non-spread products still route by prefix; only the first two matter here
    // but the ordering rule is prefix-based, so PUT* = descending pair.
    assert.deepEqual(orderSpreadStrikes('PUT_FLY', [100, 200]), [200, 100]);
    assert.deepEqual(orderSpreadStrikes('CALL_FLY', [200, 100]), [100, 200]);
  });

  test('equal strikes are stable (no crash, both equal)', () => {
    assert.deepEqual(orderSpreadStrikes('PUT_SPREAD', [1650, 1650]), [1650, 1650]);
  });
});
