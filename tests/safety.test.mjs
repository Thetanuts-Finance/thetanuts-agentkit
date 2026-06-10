// Tests run against the compiled output (dist/safety.js) so they exercise
// the exact artifact that ships to npm. `npm test` builds first.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyPolicy, isSafetyError } from '../dist/safety.js';

const MAX_UINT256 = (1n << 256n) - 1n;

const ctx = (overrides = {}) => ({
  action: 'requestRfq',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  spender: '0x0000000000000000000000000000000000000001',
  amount: 50_000_000n, // $50 in USDC base units
  isApproval: false,
  ...overrides,
});

describe('fail-closed default', () => {
  test('no limits object → every write throws SAFETY_LIMITS_REQUIRED', () => {
    const policy = new SafetyPolicy(undefined);
    assert.throws(
      () => policy.assertAllowed(ctx()),
      (err) => isSafetyError(err) && err.code === 'SAFETY_LIMITS_REQUIRED',
    );
  });

  test('zero-amount writes are also blocked without limits', () => {
    const policy = new SafetyPolicy(undefined);
    assert.throws(
      () => policy.assertAllowed(ctx({ amount: 0n })),
      (err) => err.code === 'SAFETY_LIMITS_REQUIRED',
    );
  });
});

describe('unsafe escape hatch', () => {
  test('unsafe: true allows unbounded writes', () => {
    const policy = new SafetyPolicy({ unsafe: true });
    assert.doesNotThrow(() => policy.assertAllowed(ctx({ amount: MAX_UINT256 })));
  });

  test('unsafe: true makes approvalAmount return MAX_UINT256', () => {
    const policy = new SafetyPolicy({ unsafe: true });
    assert.equal(policy.approvalAmount(1n), MAX_UINT256);
  });

  test('unsafe: true skips the onWriteAction hook', () => {
    let called = false;
    const policy = new SafetyPolicy({
      unsafe: true,
      onWriteAction: () => {
        called = true;
        return 'reject';
      },
    });
    assert.doesNotThrow(() => policy.assertAllowed(ctx()));
    assert.equal(called, false);
  });
});

describe('notional cap', () => {
  const limits = { maxNotionalUsdcPerAction: 100_000_000n }; // $100

  test('amount over the cap throws SAFETY_NOTIONAL_EXCEEDED', () => {
    const policy = new SafetyPolicy(limits);
    assert.throws(
      () => policy.assertAllowed(ctx({ amount: 100_000_001n })),
      (err) => isSafetyError(err) && err.code === 'SAFETY_NOTIONAL_EXCEEDED',
    );
  });

  test('amount exactly at the cap passes', () => {
    const policy = new SafetyPolicy(limits);
    assert.doesNotThrow(() => policy.assertAllowed(ctx({ amount: 100_000_000n })));
  });

  test('cap applies to approvals too', () => {
    const policy = new SafetyPolicy(limits);
    assert.throws(
      () => policy.assertAllowed(ctx({ action: 'approve', amount: 200_000_000n, isApproval: true })),
      (err) => err.code === 'SAFETY_NOTIONAL_EXCEEDED',
    );
  });
});

describe('collateral allowlist', () => {
  const limits = { maxNotionalUsdcPerAction: 100_000_000n, allowedCollateral: ['USDC'] };

  test('disallowed collateral throws SAFETY_COLLATERAL_NOT_ALLOWED', () => {
    const policy = new SafetyPolicy(limits);
    assert.throws(
      () => policy.assertAllowed(ctx(), { collateralSymbol: 'WETH' }),
      (err) => isSafetyError(err) && err.code === 'SAFETY_COLLATERAL_NOT_ALLOWED',
    );
  });

  test('allowed collateral passes', () => {
    const policy = new SafetyPolicy(limits);
    assert.doesNotThrow(() => policy.assertAllowed(ctx(), { collateralSymbol: 'USDC' }));
  });

  test('check is skipped when no collateral symbol is supplied', () => {
    const policy = new SafetyPolicy(limits);
    assert.doesNotThrow(() => policy.assertAllowed(ctx()));
  });

  test('empty allowlist does not block', () => {
    const policy = new SafetyPolicy({ ...limits, allowedCollateral: [] });
    assert.doesNotThrow(() => policy.assertAllowed(ctx(), { collateralSymbol: 'WETH' }));
  });
});

describe('onWriteAction host hook', () => {
  test('reject verdict throws SAFETY_REJECTED_BY_HOST', () => {
    const policy = new SafetyPolicy({
      maxNotionalUsdcPerAction: 100_000_000n,
      onWriteAction: () => 'reject',
    });
    assert.throws(
      () => policy.assertAllowed(ctx()),
      (err) => isSafetyError(err) && err.code === 'SAFETY_REJECTED_BY_HOST',
    );
  });

  test('allow verdict passes and hook receives the full context', () => {
    let seen;
    const policy = new SafetyPolicy({
      maxNotionalUsdcPerAction: 100_000_000n,
      onWriteAction: (c) => {
        seen = c;
        return 'allow';
      },
    });
    const c = ctx({ action: 'makeOffer', isApproval: false });
    assert.doesNotThrow(() => policy.assertAllowed(c));
    assert.deepEqual(seen, c);
  });

  test('hook runs after the notional cap (capped amounts never reach the hook)', () => {
    let called = false;
    const policy = new SafetyPolicy({
      maxNotionalUsdcPerAction: 100_000_000n,
      onWriteAction: () => {
        called = true;
        return 'allow';
      },
    });
    assert.throws(() => policy.assertAllowed(ctx({ amount: 999_000_000n })));
    assert.equal(called, false);
  });
});

describe('approvalAmount policy', () => {
  test("default ('exact') approves exactly the required amount", () => {
    const policy = new SafetyPolicy({ maxNotionalUsdcPerAction: 100_000_000n });
    assert.equal(policy.approvalAmount(42_000_000n), 42_000_000n);
  });

  test('bigint cap approves min(required, cap)', () => {
    const policy = new SafetyPolicy({ maxApprovalAmount: 10_000_000n });
    assert.equal(policy.approvalAmount(5_000_000n), 5_000_000n);
    assert.equal(policy.approvalAmount(50_000_000n), 10_000_000n);
  });

  test("'unlimited' approves MAX_UINT256", () => {
    const policy = new SafetyPolicy({ maxApprovalAmount: 'unlimited' });
    assert.equal(policy.approvalAmount(1n), MAX_UINT256);
  });
});

describe('isSafetyError', () => {
  test('false for plain errors, true for policy errors', () => {
    assert.equal(isSafetyError(new Error('boom')), false);
    assert.equal(isSafetyError('not an error'), false);
    const policy = new SafetyPolicy(undefined);
    try {
      policy.assertAllowed(ctx());
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(isSafetyError(err), true);
    }
  });
});
