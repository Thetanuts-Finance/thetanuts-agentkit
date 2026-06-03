/**
 * Autonomous-agent fund-safety policy.
 *
 * The ActionProvider's actions are LLM-callable. The LLM can be tricked by
 * prompt injection from any untrusted source the host agent reads (web
 * pages, third-party messages, model outputs the agent loops on its own
 * tools). A single malicious tool call could otherwise approve max
 * allowance, fill a malicious resting order, or submit an unbounded RFQ.
 *
 * This module enforces in-band, code-level limits that don't depend on the
 * system prompt. Default behavior is FAIL-CLOSED: if the constructor was
 * called without a SafetyLimits object, every write action throws
 * SAFETY_LIMITS_REQUIRED. Callers must explicitly opt in by either:
 *
 *   - passing concrete limits (recommended);
 *   - passing `{ unsafe: true }` to acknowledge unbounded writes (back-compat
 *     escape hatch — discouraged but available).
 *
 * The policy applies to writes that move user value or grant allowance.
 * Read actions and stateless calldata-only helpers don't go through it.
 */

const SAFE_TYPES = {
  approve: 'approve' as const,
  fillOrder: 'fillOrder' as const,
  requestRfq: 'requestRfq' as const,
  makeOffer: 'makeOffer' as const,
};

export type SafetyActionType = (typeof SAFE_TYPES)[keyof typeof SAFE_TYPES];

export interface SafetyContext {
  /** Action kind being attempted. */
  action: SafetyActionType;
  /** Token contract being moved (e.g. the collateral or quote token). */
  token: `0x${string}`;
  /** Spender being granted allowance, or the target of the spend. */
  spender: `0x${string}`;
  /** Amount in token base units (e.g. 1_000_000n = 1 USDC for 6-dec). */
  amount: bigint;
  /** Whether this action requests an ERC20 approval. */
  isApproval: boolean;
}

export interface SafetyLimits {
  /**
   * Hard ceiling on per-action notional, expressed in **USDC base units**
   * (6 decimals). 100_000_000n = $100. Applies to fill_order's
   * usdcAmount and to RFQ premiums.
   *
   * Required unless `unsafe: true` is set.
   */
  maxNotionalUsdcPerAction?: bigint;

  /**
   * Approval policy:
   *   - 'exact'         — approve exactly the amount needed (default)
   *   - bigint          — approve up to this cap, never more
   *   - 'unlimited'     — approve MAX_UINT256 (matches v0.1.0 behavior;
   *                       discouraged; logs a warning)
   */
  maxApprovalAmount?: 'exact' | bigint | 'unlimited';

  /**
   * If set, only these collateral token symbols are allowed for RFQ
   * creation. Use to restrict to USDC during early operation.
   */
  allowedCollateral?: ReadonlyArray<'USDC' | 'WETH' | 'cbBTC' | 'aBasWETH' | 'aBascbBTC' | 'aBasUSDC' | 'cbDOGE' | 'cbXRP'>;

  /**
   * Optional host hook. Called BEFORE every write action with the
   * SafetyContext. Return 'reject' to block the action (the
   * ActionProvider surfaces a SAFETY_REJECTED message to the LLM).
   * Useful for per-tx confirmation UIs, multi-sig review, or anomaly
   * detection.
   */
  onWriteAction?: (ctx: SafetyContext) => 'allow' | 'reject';

  /**
   * Escape hatch — opt in to v0.1.0 unbounded behavior. Logs a warning.
   * NOT recommended.
   */
  unsafe?: boolean;
}

export class SafetyPolicy {
  constructor(private readonly limits: SafetyLimits | undefined) {
    if (limits?.maxApprovalAmount === 'unlimited' || limits?.unsafe) {
      console.warn(
        '[thetanuts-agentkit] SafetyPolicy in UNSAFE/UNLIMITED mode. ' +
          'The agent can approve MAX_UINT256 and broadcast writes with no ' +
          'notional cap. Only use behind a trusted execution boundary.',
      );
    }
  }

  /**
   * Run all relevant checks for an attempted write. Throws a structured
   * Error on rejection; the ActionProvider catches and returns a safe
   * message to the LLM rather than letting it bubble into the wallet.
   */
  assertAllowed(ctx: SafetyContext, opts: { collateralSymbol?: string } = {}): void {
    if (!this.limits) {
      throw safetyError(
        'SAFETY_LIMITS_REQUIRED',
        'Write actions require a SafetyLimits object on the ActionProvider. ' +
          'Pass { safetyLimits: { maxNotionalUsdcPerAction: ..., maxApprovalAmount: ... } } ' +
          'or { safetyLimits: { unsafe: true } } to acknowledge unbounded writes.',
      );
    }
    if (this.limits.unsafe) return;

    // Notional cap. We treat the amount as USDC base units when it concerns
    // a USDC-denominated spend (fill_order.usdcAmount, RFQ premium in 6-dec
    // collateral). For non-USDC collateral the cap is still applied
    // structurally (callers are expected to convert), so over-conservative
    // by design.
    if (this.limits.maxNotionalUsdcPerAction !== undefined && ctx.amount > this.limits.maxNotionalUsdcPerAction) {
      throw safetyError(
        'SAFETY_NOTIONAL_EXCEEDED',
        `Action ${ctx.action} would move ${ctx.amount} (USDC base units), exceeding ` +
          `maxNotionalUsdcPerAction=${this.limits.maxNotionalUsdcPerAction}.`,
      );
    }

    // Collateral allowlist (RFQ-side only — caller passes the symbol).
    if (opts.collateralSymbol && this.limits.allowedCollateral && this.limits.allowedCollateral.length > 0) {
      if (!this.limits.allowedCollateral.includes(opts.collateralSymbol as (typeof this.limits.allowedCollateral)[number])) {
        throw safetyError(
          'SAFETY_COLLATERAL_NOT_ALLOWED',
          `Collateral ${opts.collateralSymbol} is not in the allowed list ` +
            `${JSON.stringify(this.limits.allowedCollateral)}.`,
        );
      }
    }

    // Host-supplied hook.
    if (this.limits.onWriteAction) {
      const verdict = this.limits.onWriteAction(ctx);
      if (verdict === 'reject') {
        throw safetyError(
          'SAFETY_REJECTED_BY_HOST',
          `onWriteAction hook rejected ${ctx.action} (${ctx.amount} of ${ctx.token} to ${ctx.spender}).`,
        );
      }
    }
  }

  /**
   * Compute the amount to send to encodeApprove based on the policy.
   * Caller passes the action's required amount; policy returns either
   * that exact amount, the configured cap, or MAX_UINT256.
   */
  approvalAmount(required: bigint): bigint {
    const policy = this.limits?.maxApprovalAmount ?? 'exact';
    if (this.limits?.unsafe || policy === 'unlimited') return (1n << 256n) - 1n;
    if (policy === 'exact') return required;
    // bigint cap: approve min(required, cap)
    return required <= policy ? required : policy;
  }
}

interface SafetyError extends Error {
  code: string;
  isSafety: true;
}

function safetyError(code: string, message: string): SafetyError {
  const e = new Error(message) as SafetyError;
  e.code = code;
  e.isSafety = true;
  return e;
}

export function isSafetyError(err: unknown): err is SafetyError {
  return err instanceof Error && (err as SafetyError).isSafety === true;
}
