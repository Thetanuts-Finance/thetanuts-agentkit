// =============================================================================
// MM quote helper — compute the price the market-maker will ACTUALLY quote for a
// structure, so a caller can size a reserve that clears.
//
// Why this exists: the public pricing feed (pricing.thetanuts.finance) is
// indicative and prices tighter than the MM's real RFQ quote. The MM (mm_bot.py)
// prices a NON-whitelisted requester off the wider bid/ask legs + per-leg fees +
// a spread collateral cost — routinely ~40-50% above the public feed. Sizing an
// RFQ reserve off the public feed makes the reserve too low, so the MM's offer
// exceeds it and the RFQ expires with no fill (exactly what happened on RFQ 87:
// MM quoted $5.30, reserve was $5.00).
//
// The thetanuts-client SDK already replicates the MM's exact math
// (mmPricing.getSpreadPricing / getTickerPricing return non-whitelisted `mm*`
// AND whitelisted `mmWl*` prices, matching mm_bot.py). We just call it.
// =============================================================================
import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import {
  buildTicker,
  calculateReservePrice,
  premiumPerContract,
} from '@thetanuts-finance/thetanuts-client';

export interface MmQuoteParams {
  product: string; // PUT, CALL, PUT_SPREAD, CALL_SPREAD, ...
  underlying: string; // ETH, BTC
  strikes: number[]; // human-readable, e.g. [1650, 1675]
  expiry: number; // unix seconds
  numContracts: number; // default 1
}

export interface MmQuote {
  product: string;
  underlying: string;
  strikes: number[];
  spot: number;
  /** MM ask in underlying terms (what the SDK returns). */
  mmAskUnderlying: number;
  /** MM ask premium in USD, per contract. */
  mmAskUsdPerContract: number;
  /** MM ask premium in USD, total for numContracts. */
  mmAskUsdTotal: number;
  /** A reserve that clears the MM ask, per contract, with a safety buffer. */
  recommendedReserveUsdPerContract: number;
  /** Total recommended reserve for numContracts. */
  recommendedReserveUsdTotal: number;
  /** Buffer applied over the raw MM ask (fraction). */
  bufferPct: number;
  note: string;
}

// Headroom over the raw MM ask so movement between quote and RFQ execution
// doesn't push the real offer back above the reserve. Set generous (25%) because
// the MM re-prices off live Deribit at RFQ time — the gap between our quote and
// the MM's actual offer can be sizable if spot moves (observed ~30% on RFQ 87).
const RESERVE_BUFFER_PCT = 0.25;

const isSpread = (product: string): boolean =>
  product.endsWith('_SPREAD');

/**
 * Order strikes the way the MM (mm_bot.py) expects for spread pricing:
 *   CALL_SPREAD: [lower, higher]  (ascending)
 *   PUT_SPREAD:  [higher, lower]  (descending)
 * Passing the wrong order flips near/far and computes (low_ask - high_bid) — a
 * near-zero, badly-wrong price (the 48x bug). This enforces the convention.
 */
export function orderSpreadStrikes(product: string, strikes: number[]): [number, number] {
  const [a, b] = strikes as [number, number];
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return product.startsWith('CALL') ? [lo, hi] : [hi, lo];
}

/**
 * Quote the MM's expected (non-whitelisted) price for a structure and a reserve
 * that clears it. Supports single-leg (PUT/CALL) and 2-strike spreads.
 */
export async function getMmQuoteForStructure(
  client: ThetanutsClient,
  params: MmQuoteParams,
): Promise<MmQuote> {
  const { product, underlying, strikes, expiry } = params;
  const numContracts = params.numContracts > 0 ? params.numContracts : 1;
  const isCall = product.startsWith('CALL');

  let mmAskUnderlying: number;
  let spot: number;

  if (isSpread(product)) {
    if (strikes.length !== 2) {
      throw new Error(`get_mm_quote: ${product} needs exactly 2 strikes, got ${strikes.length}.`);
    }
    // getSpreadPricing wants strikes as 8-decimal bigints, [near, far] in the
    // MM's expected order (PUT: descending, CALL: ascending) — enforce it so we
    // never hit the flipped-order 48x-wrong price.
    const [near, far] = orderSpreadStrikes(product, strikes);
    const toBig = (s: number): bigint => BigInt(Math.round(s * 1e8));
    const quote = await client.mmPricing.getSpreadPricing({
      underlying,
      strikes: [toBig(near), toBig(far)],
      expiry,
      isCall,
    });
    mmAskUnderlying = quote.netMmAskPrice;
    spot = quote.nearLeg.underlyingPrice;
  } else {
    // Single-leg PUT/CALL — price the one strike via the ticker.
    if (strikes.length !== 1) {
      throw new Error(`get_mm_quote: ${product} needs exactly 1 strike, got ${strikes.length}.`);
    }
    const ticker = buildTicker(underlying, expiry, strikes[0]!, isCall);
    const vanilla = await client.mmPricing.getTickerPricing(ticker);
    // feeAdjustedAsk = the non-whitelisted, fee-widened ask (what the MM quotes a
    // non-whitelisted requester). This matches mm_bot.py's fee_adjust for
    // non-whitelisted (bid/ask + per-leg fee), not the tighter mark-based WL price.
    mmAskUnderlying = vanilla.feeAdjustedAsk;
    spot = vanilla.underlyingPrice;
  }

  // Convert underlying-terms price → USD premium per contract (× spot for
  // USD-collateral products; identity for base-collateral). Reuse the SDK's
  // exact conversion so it matches what the factory pulls.
  const mmAskUsdPerContract = premiumPerContract(mmAskUnderlying, spot, product as never);
  const mmAskUsdTotal = mmAskUsdPerContract * numContracts;

  // A reserve that clears, with buffer. calculateReservePrice gives the
  // per-order USD reserve for the raw MM price; add the buffer on top.
  const rawReserveTotal = calculateReservePrice(numContracts, mmAskUnderlying, spot, product as never);
  const recommendedReserveUsdTotal = rawReserveTotal * (1 + RESERVE_BUFFER_PCT);
  const recommendedReserveUsdPerContract = recommendedReserveUsdTotal / numContracts;

  return {
    product,
    underlying,
    strikes,
    spot,
    mmAskUnderlying,
    mmAskUsdPerContract,
    mmAskUsdTotal,
    recommendedReserveUsdPerContract,
    recommendedReserveUsdTotal,
    bufferPct: RESERVE_BUFFER_PCT,
    note:
      'Non-whitelisted MM quote (matches mm_bot.py). Set reservePriceUsdc >= ' +
      `${recommendedReserveUsdPerContract.toFixed(2)} per contract for this to fill.`,
  };
}
