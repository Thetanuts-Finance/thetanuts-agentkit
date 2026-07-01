import { z } from 'zod';

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');
const HEX = z.string().regex(/^0x[0-9a-fA-F]+$/, 'must be 0x-prefixed hex');
const DECIMAL_STRING = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal');
const INT_STRING = z.string().regex(/^\d+$/, 'must be a non-negative integer string');

export const ProductEnum = z.enum([
  'PUT', 'CALL',
  'CALL_SPREAD', 'PUT_SPREAD',
  'CALL_FLY', 'PUT_FLY',
  'CALL_CONDOR', 'PUT_CONDOR',
  'IRON_CONDOR',
]);

export const UnderlyingEnum = z.enum(['ETH', 'BTC']);
export const CollateralEnum = z.enum([
  'USDC', 'WETH', 'cbBTC',
  'aBasWETH', 'aBascbBTC', 'aBasUSDC',
  'cbDOGE', 'cbXRP',
]);

// ---------- ERC20 ----------

export const ApproveSchema = z.object({
  token: ADDRESS.describe('ERC20 token contract address to approve'),
  spender: ADDRESS.describe('Address allowed to spend the token'),
  amount: INT_STRING.describe('Amount in token base units (e.g. 6 decimals for USDC, "1000000" = 1 USDC). Use "max" for unlimited.').or(z.literal('max')),
});

// ---------- RFQ ----------

export const RequestRfqSchema = z.object({
  product: ProductEnum.describe('Option structure. 1 strike: PUT or CALL. 2 strikes: spread. 3 strikes: fly. 4 strikes: condor or IRON_CONDOR.'),
  underlying: UnderlyingEnum.describe('Underlying asset.'),
  collateral: CollateralEnum.describe('Collateral token. USDC is the default; WETH/cbBTC for inverse calls.'),
  strikes: z.array(DECIMAL_STRING).min(1).max(4).describe('Strike price(s) in human-readable decimal (e.g. "1850" for $1850). Number must match the product type. Will be sorted ascending.'),
  numContracts: DECIMAL_STRING.describe('Number of contracts in human-readable decimal (e.g. "1.5"). Server converts using token decimals.'),
  expiry: z.number().int().positive().describe('Option expiry as a Unix timestamp (seconds).'),
  offerEndTimestamp: z.number().int().positive().optional().describe('Offer window end as a Unix timestamp (seconds). DEFAULTS to now + 30 seconds if omitted — a short window so the agent finds out quickly whether MMs care. Override to e.g. now + 300 for a 5-minute window with broader MM coverage.'),
  isRequestingLongPosition: z.boolean().describe('True if the agent wants to BUY the option (long), false to SELL (short, requires collateral approval).'),
  reservePrice: DECIMAL_STRING.optional().describe('Optional reserve price per contract in collateral units. Offers below this will be ignored.'),
  isIronCondor: z.boolean().optional().describe('Set true when product is IRON_CONDOR with 4 strikes. Defaults to false.'),
});

export const MakeOfferSchema = z.object({
  quotationId: INT_STRING.describe('On-chain quotation ID returned by request_rfq (or read from State API).'),
  offerAmount: INT_STRING.describe('Offer premium in collateral token BASE UNITS (e.g. 6 decimals for USDC: "50000000" = 50 USDC).'),
});

export const SettleRfqSchema = z.object({
  quotationId: INT_STRING.describe('Quotation ID to settle. Use this AFTER the offer window has closed; for early settlement use settle_rfq_early.'),
});

export const SettleRfqEarlySchema = z.object({
  quotationId: INT_STRING.describe('Quotation ID to settle early.'),
  offerorAddress: ADDRESS.describe('Address of the market maker whose offer the requester is accepting.'),
});

export const CancelRfqSchema = z.object({
  quotationId: INT_STRING.describe('Quotation ID to cancel (only the requester can cancel their own RFQ).'),
});

export const CancelOfferSchema = z.object({
  quotationId: INT_STRING.describe('Quotation ID whose offer the agent wants to retract.'),
});

export const TransferPositionSchema = z.object({
  optionAddress: ADDRESS.describe('BaseOption contract address of the settled position to transfer. Look it up via get_user_positions after settling.'),
  isBuyer: z.boolean().describe('Which leg to transfer: true = the buyer (long) position, false = the seller (short/written) position.'),
  target: ADDRESS.describe('Recipient address that will own the position after transfer.'),
});

// ---------- Read helpers ----------

export const GetUserPositionsSchema = z.object({
  address: ADDRESS.optional().describe('Wallet address. Omit to use the agent\'s own wallet.'),
});

export const GetRfqSchema = z.object({
  quotationId: INT_STRING.describe('Quotation ID to look up.'),
});

export const GetMarketPricesSchema = z.object({});

// ---------- Internal types ----------

export type ApproveArgs = z.infer<typeof ApproveSchema>;
export type RequestRfqArgs = z.infer<typeof RequestRfqSchema>;
export type MakeOfferArgs = z.infer<typeof MakeOfferSchema>;
export type SettleRfqArgs = z.infer<typeof SettleRfqSchema>;
export type SettleRfqEarlyArgs = z.infer<typeof SettleRfqEarlySchema>;
export type CancelRfqArgs = z.infer<typeof CancelRfqSchema>;
export type CancelOfferArgs = z.infer<typeof CancelOfferSchema>;
export type TransferPositionArgs = z.infer<typeof TransferPositionSchema>;
export type GetUserPositionsArgs = z.infer<typeof GetUserPositionsSchema>;
export type GetRfqArgs = z.infer<typeof GetRfqSchema>;

// Re-export the validators for filtering
export { ADDRESS, HEX, DECIMAL_STRING, INT_STRING };
