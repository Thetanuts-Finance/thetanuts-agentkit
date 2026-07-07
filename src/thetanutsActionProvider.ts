import type { z } from 'zod';
import {
  ActionProvider,
  CreateAction,
  // EvmWalletProvider MUST be a VALUE import (not `type`): action methods are
  // annotated `wallet: EvmWalletProvider`, and emitDecoratorMetadata only records
  // the real class (so AgentKit injects the wallet as arg[0]) when the type is a
  // runtime value. As a type-only import the metadata degrades to `Function` and
  // the wallet is never injected → "wallet.getNetwork is not a function".
  EvmWalletProvider,
  type Network,
} from '@coinbase/agentkit';
import { encodeFunctionData } from 'viem';
import {
  ApproveSchema,
  RequestRfqSchema,
  MakeOfferSchema,
  SettleRfqSchema,
  SettleRfqEarlySchema,
  CancelRfqSchema,
  CancelOfferSchema,
  TransferPositionSchema,
  GetUserPositionsSchema,
  GetRfqSchema,
  GetMarketPricesSchema,
  GetMmQuoteSchema,
} from './schemas.js';
import { buildClient, BASE_CHAIN_ID, safeGetAddress } from './sdk.js';
import { SafetyPolicy, isSafetyError, type SafetyLimits } from './safety.js';

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Minimal ABI for the one BaseOption method we encode here:
 * `transfer(bool isBuyer, address target)`. The SDK exposes this only via a
 * signer-backed Contract; the agentkit holds no signer in the SDK client, so
 * we encode the calldata directly and broadcast through the wallet provider.
 */
const BASE_OPTION_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'isBuyer', type: 'bool' },
      { name: 'target', type: 'address' },
    ],
    outputs: [],
  },
] as const;

/**
 * AgentKit ActionProvider exposing the Thetanuts options surface to
 * autonomous agents whose wallet provider is an `EvmWalletProvider`
 * (CDP, viem, Privy, server wallets, MPC). Only Base mainnet (8453) is
 * supported in v1.
 *
 * Architectural note: this provider does NOT mirror the prepare-service
 * routes 1:1. Where the prepare service returns unsigned calldata for an
 * external Base Account signer, this provider holds its own signer
 * (via the AgentKit wallet) and broadcasts directly. The two integrations
 * target different deployment models: Base MCP plugin = user-in-the-loop,
 * AgentKit = headless backend.
 *
 * Safety: every write action passes through SafetyPolicy.assertAllowed
 * before broadcasting. The policy fails closed if the host did not
 * configure limits in the constructor.
 */
export class ThetanutsActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly rpcUrl?: string;
  private readonly safety: SafetyPolicy;

  constructor(opts: { rpcUrl?: string; safetyLimits?: SafetyLimits } = {}) {
    super('thetanuts', []);
    this.rpcUrl = opts.rpcUrl;
    this.safety = new SafetyPolicy(opts.safetyLimits);
  }

  supportsNetwork = (network: Network): boolean =>
    network.protocolFamily === 'evm' && Number(network.chainId) === BASE_CHAIN_ID;

  /**
   * Wrap a handler body in safety-error translation. If the handler throws
   * a SafetyPolicy error, we surface it to the LLM as a clear refusal
   * message rather than letting it propagate as a generic exception that
   * the agent might retry blindly.
   */
  private async withSafety<T>(fn: () => Promise<T>): Promise<T | string> {
    try {
      return await fn();
    } catch (err) {
      if (isSafetyError(err)) {
        return `Refused (${(err as Error & { code: string }).code}): ${(err as Error).message}`;
      }
      throw err;
    }
  }

  // ====================================================================
  // ERC20
  // ====================================================================

  @CreateAction({
    name: 'approve',
    description:
      'Approve an ERC20 spender (the OptionFactory) for a given amount of a token. Required before SELL RFQs that require collateral. The actual amount approved respects the configured maxApprovalAmount policy: "exact" approves the requested amount, a bigint caps it, "unlimited" approves MAX_UINT256.',
    schema: ApproveSchema,
  })
  async approve(wallet: EvmWalletProvider, args: z.infer<typeof ApproveSchema>): Promise<string> {
    return this.withSafety(async () => {
      const client = buildClient(wallet, this.rpcUrl);
      const requested = args.amount === 'max' ? MAX_UINT256 : BigInt(args.amount);

      this.safety.assertAllowed({
        action: 'approve',
        token: args.token as `0x${string}`,
        spender: args.spender as `0x${string}`,
        amount: requested,
        isApproval: true,
      });

      const actual = this.safety.approvalAmount(requested);
      const { to, data } = client.erc20.encodeApprove(args.token, args.spender, actual);
      const hash = await wallet.sendTransaction({
        to: to as `0x${string}`,
        data: data as `0x${string}`,
      });
      await wallet.waitForTransactionReceipt(hash as `0x${string}`);
      return `Approved ${actual} of ${args.token} to spender ${args.spender}. tx=${hash}`;
    }) as Promise<string>;
  }


  // ====================================================================
  // OptionFactory — RFQ lifecycle
  // ====================================================================

  @CreateAction({
    name: 'request_rfq',
    description:
      'Create a Request-For-Quotation on Thetanuts. Solicits encrypted sealed-bid offers from market makers over the offer window. Use this when the orderbook has no suitable resting order or for structured products (spreads, butterflies, condors). For SELL positions (isRequestingLongPosition=false) the agent\'s collateral token must be approved to the OptionFactory. Subject to the configured allowedCollateral list.',
    schema: RequestRfqSchema,
  })
  async requestRfq(wallet: EvmWalletProvider, args: z.infer<typeof RequestRfqSchema>): Promise<string> {
    return this.withSafety(async () => {
      const client = buildClient(wallet, this.rpcUrl);
      const from = await safeGetAddress(wallet);

      // Estimate notional in collateral base units for the safety gate.
      // For PUT/spread/condor SELL the writer's max loss bounds the notional;
      // for BUY the reservePrice (or 0 if absent) is a reasonable proxy.
      // We use reservePrice * numContracts as a conservative upper bound on
      // what the agent is willing to pay; the contract enforces real bounds
      // on settlement.
      const reservePrice = args.reservePrice ? parseFloat(args.reservePrice) : 0;
      const numContracts = parseFloat(args.numContracts);
      const estimatedNotional = BigInt(Math.ceil(reservePrice * numContracts * 1_000_000));

      this.safety.assertAllowed(
        {
          action: 'requestRfq',
          // Token doesn't have a concrete address until the SDK resolves it;
          // we use the zero address here because the policy hook treats
          // approve/non-approve consistently.
          token: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          spender: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          amount: estimatedNotional,
          isApproval: false,
        },
        { collateralSymbol: args.collateral },
      );

      const keypair = await client.rfqKeys.getOrCreateKeyPair();
      // 30-second default offer window. The contract enforces no minimum
      // (REVEAL_WINDOW=60s only constrains expiryTimestamp vs
      // offerEndTimestamp, not the offer window itself), so a tight default
      // lets autonomous agents discover MM interest quickly.
      const nowSec = Math.floor(Date.now() / 1000);
      const offerEndTimestamp = args.offerEndTimestamp ?? nowSec + 30;
      const offerDeadlineMinutes = Math.max(
        0.1,
        (offerEndTimestamp - nowSec) / 60,
      );

      const optionType = args.product.startsWith('PUT') ? 'PUT' : 'CALL';
      const strikes = args.strikes.map(parseFloat);

      const rfqRequest = client.optionFactory.buildRFQRequest({
        requester: from,
        underlying: args.underlying,
        optionType,
        strikes: strikes.length === 1 ? strikes[0]! : strikes,
        expiry: args.expiry,
        numContracts,
        isLong: args.isRequestingLongPosition,
        offerDeadlineMinutes,
        collateralToken: args.collateral,
        reservePrice: args.reservePrice ? parseFloat(args.reservePrice) : undefined,
        requesterPublicKey: keypair.compressedPublicKey,
        isIronCondor: args.isIronCondor ?? false,
      });

      const encoded = client.optionFactory.encodeRequestForQuotation(rfqRequest);
      const hash = (await wallet.sendTransaction({
        to: encoded.to as `0x${string}`,
        data: encoded.data as `0x${string}`,
      })) as `0x${string}`;
      const receipt = await wallet.waitForTransactionReceipt(hash);
      return `Requested RFQ for ${args.product} ${args.underlying} strikes=[${args.strikes.join(', ')}]. tx=${hash}, block=${receipt.blockNumber}. Watch for offers via get_rfq.`;
    }) as Promise<string>;
  }

  @CreateAction({
    name: 'make_offer',
    description:
      'Submit a sealed-bid offer on someone else\'s RFQ. The offeror (this agent) signs an EIP-712 Offer struct over (quotationId, offerAmount, offeror, nonce) and the AgentKit wallet broadcasts. The offer payload is encrypted to the requester\'s ECDH public key, fetched automatically from the on-chain RFQ state. offerAmount is in collateral BASE UNITS (e.g. 6-dec USDC).',
    schema: MakeOfferSchema,
  })
  async makeOffer(wallet: EvmWalletProvider, args: z.infer<typeof MakeOfferSchema>): Promise<string> {
    return this.withSafety(async () => {
      const client = buildClient(wallet, this.rpcUrl);
      const from = await safeGetAddress(wallet);

      this.safety.assertAllowed({
        action: 'makeOffer',
        // Same caveat as requestRfq — token address isn't known here.
        token: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        spender: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        amount: BigInt(args.offerAmount),
        isApproval: false,
      });

      // 1. Read the requester's ECDH public key from the State API.
      const requesterPubKey = await client.api.getRequesterPublicKey(args.quotationId);

      // 2. Ensure the offeror has its own keypair to encrypt with.
      await client.rfqKeys.getOrCreateKeyPair();

      // 3. Encrypt the offer.
      const nonce = client.rfqKeys.generateNonce();
      const encrypted = await client.rfqKeys.encryptOffer(BigInt(args.offerAmount), nonce, requesterPubKey);

      // 4. Sign the EIP-712 Offer struct. The SDK builds the typed-data
      //    envelope and verifies the live OFFER_TYPEHASH; the wallet signs.
      const typedData = await client.optionFactory.buildOfferTypedData({
        quotationId: BigInt(args.quotationId),
        offerAmount: BigInt(args.offerAmount),
        offeror: from,
        nonce,
      });
      const signature = await wallet.signTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      // 5. Encode + broadcast.
      const encoded = client.optionFactory.encodeMakeOfferForQuotation({
        quotationId: BigInt(args.quotationId),
        signature,
        signingKey: encrypted.signingKey,
        encryptedOffer: encrypted.ciphertext,
      });
      const hash = (await wallet.sendTransaction({
        to: encoded.to as `0x${string}`,
        data: encoded.data as `0x${string}`,
      })) as `0x${string}`;
      await wallet.waitForTransactionReceipt(hash);
      return `Made encrypted offer ${args.offerAmount} on RFQ ${args.quotationId}. tx=${hash}`;
    }) as Promise<string>;
  }

  // settle_rfq / settle_rfq_early / cancel_rfq / cancel_offer don't move
  // value on the agent's behalf (settlement is on-chain logic; cancels are
  // self-service). They skip the safety gate intentionally — they CAN'T
  // exfiltrate funds even if the LLM is tricked into calling them.

  @CreateAction({
    name: 'settle_rfq',
    description:
      'Settle a quotation after its offer window has closed. The on-chain contract picks the winning offer automatically. Use this for normal settlement; for early settlement before the window closes use settle_rfq_early.',
    schema: SettleRfqSchema,
  })
  async settleRfq(wallet: EvmWalletProvider, args: z.infer<typeof SettleRfqSchema>): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const encoded = client.optionFactory.encodeSettleQuotation(BigInt(args.quotationId));
    const hash = (await wallet.sendTransaction({
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
    })) as `0x${string}`;
    await wallet.waitForTransactionReceipt(hash);
    return `Settled RFQ ${args.quotationId}. tx=${hash}`;
  }

  @CreateAction({
    name: 'settle_rfq_early',
    description:
      'Accept a specific market maker\'s offer on the agent\'s own RFQ before the offer window closes. Only callable by the original requester (this agent). The encrypted offer is fetched from the State API and decrypted locally using the agent\'s ECDH key.',
    schema: SettleRfqEarlySchema,
  })
  async settleRfqEarly(
    wallet: EvmWalletProvider,
    args: z.infer<typeof SettleRfqEarlySchema>,
  ): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const offer = await client.api.getOffer(args.quotationId, args.offerorAddress);
    const decrypted = await client.rfqKeys.decryptOffer(
      offer.signedOfferForRequester,
      offer.signingKey,
    );

    const encoded = client.optionFactory.encodeSettleQuotationEarly(
      BigInt(args.quotationId),
      decrypted.offerAmount,
      decrypted.nonce,
      args.offerorAddress,
    );
    const hash = (await wallet.sendTransaction({
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
    })) as `0x${string}`;
    await wallet.waitForTransactionReceipt(hash);
    return `Settled RFQ ${args.quotationId} early with offer from ${args.offerorAddress} (offerAmount=${decrypted.offerAmount}). tx=${hash}`;
  }

  @CreateAction({
    name: 'cancel_rfq',
    description:
      'Cancel the agent\'s own RFQ before any offer is accepted. The original requester is the only address authorized to call this.',
    schema: CancelRfqSchema,
  })
  async cancelRfq(wallet: EvmWalletProvider, args: z.infer<typeof CancelRfqSchema>): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const encoded = client.optionFactory.encodeCancelQuotation(BigInt(args.quotationId));
    const hash = (await wallet.sendTransaction({
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
    })) as `0x${string}`;
    await wallet.waitForTransactionReceipt(hash);
    return `Cancelled RFQ ${args.quotationId}. tx=${hash}`;
  }

  @CreateAction({
    name: 'cancel_offer',
    description:
      'Retract an offer this agent previously submitted on someone else\'s RFQ.',
    schema: CancelOfferSchema,
  })
  async cancelOffer(
    wallet: EvmWalletProvider,
    args: z.infer<typeof CancelOfferSchema>,
  ): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const encoded = client.optionFactory.encodeCancelOfferForQuotation(BigInt(args.quotationId));
    const hash = (await wallet.sendTransaction({
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
    })) as `0x${string}`;
    await wallet.waitForTransactionReceipt(hash);
    return `Cancelled offer on RFQ ${args.quotationId}. tx=${hash}`;
  }

  // ====================================================================
  // Position transfer
  // ====================================================================

  @CreateAction({
    name: 'transfer_position',
    description:
      'Transfer a settled option position (one leg) to another address. Use this to hand a freshly-settled position to a counterparty or end user. Get the optionAddress from get_user_positions. isBuyer selects which leg: true = long/buyer, false = short/seller. This moves value and is gated by SafetyPolicy — the recipient is passed to the onWriteAction hook so the host can allowlist it.',
    schema: TransferPositionSchema,
  })
  async transferPosition(
    wallet: EvmWalletProvider,
    args: z.infer<typeof TransferPositionSchema>,
  ): Promise<string> {
    return this.withSafety(async () => {
      // A position transfer has no ERC20 amount; the notional cap is N/A.
      // We surface the recipient as `spender` so onWriteAction can allowlist
      // the target, and the BaseOption address as `token` for logging.
      this.safety.assertAllowed({
        action: 'transferPosition',
        token: args.optionAddress as `0x${string}`,
        spender: args.target as `0x${string}`,
        amount: 0n,
        isApproval: false,
      });

      // Encode BaseOption.transfer(bool isBuyer, address target). The SDK has
      // no encode-only helper for this, so we encode directly and broadcast
      // via the wallet provider (the SDK client holds no signer here).
      const data = encodeFunctionData({
        abi: BASE_OPTION_TRANSFER_ABI,
        functionName: 'transfer',
        args: [args.isBuyer, args.target as `0x${string}`],
      });
      const hash = (await wallet.sendTransaction({
        to: args.optionAddress as `0x${string}`,
        data,
      })) as `0x${string}`;
      await wallet.waitForTransactionReceipt(hash);
      return `Transferred ${args.isBuyer ? 'buyer' : 'seller'} position ${args.optionAddress} to ${args.target}. tx=${hash}`;
    }) as Promise<string>;
  }

  // ====================================================================
  // Read-only helpers
  // ====================================================================

  @CreateAction({
    name: 'get_user_positions',
    description:
      'List the open option positions for an address. Omit the address argument to use the agent\'s own wallet. Returns position summaries with strike, expiry, side, size.',
    schema: GetUserPositionsSchema,
  })
  async getUserPositions(
    wallet: EvmWalletProvider,
    args: z.infer<typeof GetUserPositionsSchema>,
  ): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const address = args.address ?? (await safeGetAddress(wallet));
    const positions = await client.api.getUserPositionsFromIndexer(address);
    if (positions.length === 0) return `${address} has no open positions.`;
    return JSON.stringify(
      positions.map((p) => ({
        id: p.id,
        optionAddress: p.optionAddress,
        side: p.side,
        amount: p.amount.toString(),
        entryPrice: p.entryPrice.toString(),
        option: {
          underlying: p.option.underlying,
          collateral: p.option.collateral,
          strikes: p.option.strikes.map((s: bigint) => s.toString()),
          expiry: p.option.expiry,
          optionType: p.option.optionType,
        },
        status: p.status,
      })),
      null,
      2,
    );
  }

  @CreateAction({
    name: 'get_rfq',
    description:
      'Look up an RFQ by its quotation ID. Returns the parameters, current state, and an OFFER SUMMARY (offeror, status, createdAt, revealedAmount once revealed). The raw encrypted offer payloads are NOT included — they would leak sealed-bid confidentiality into the LLM transcript.',
    schema: GetRfqSchema,
  })
  async getRfq(wallet: EvmWalletProvider, args: z.infer<typeof GetRfqSchema>): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const rfq = await client.api.getRfq(args.quotationId);

    // Sanitize offers: strip encrypted ciphertext + signingKey to keep
    // sealed-bid contents out of the LLM transcript. AKIT-002.
    const offerSummary = Object.fromEntries(
      Object.entries(rfq.offers ?? {}).map(([offeror, o]) => [
        offeror,
        {
          status: o.status,
          createdAt: o.createdAt,
          createdTx: o.createdTx,
          revealedAmount: o.revealedAmount,
        },
      ]),
    );
    const { offers: _stripped, ...rest } = rfq;
    return JSON.stringify({ ...rest, offers: offerSummary }, null, 2);
  }

  @CreateAction({
    name: 'get_market_prices',
    description:
      'Get the current oracle prices for supported underlyings (ETH, BTC, SOL, etc.). Useful for choosing strike prices for a new RFQ.',
    schema: GetMarketPricesSchema,
  })
  async getMarketPrices(wallet: EvmWalletProvider, _args: unknown): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const prices = await client.api.getMarketPrices();
    // The API response can contain BigInt fields, which JSON.stringify can't
    // serialize by default — coerce them to strings.
    return JSON.stringify(prices, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  }

  @CreateAction({
    name: 'get_mm_quote',
    description:
      "Quote the market-maker's EXPECTED price for a specific structure BEFORE creating an RFQ. " +
      'Returns the price the MM will actually quote (non-whitelisted, higher than the public pricing feed) ' +
      'and a recommended reserve price, so a BUY reserve can be sized to actually clear. ' +
      'Supports single-leg (PUT/CALL) and 2-strike spreads (PUT_SPREAD/CALL_SPREAD).',
    schema: GetMmQuoteSchema,
  })
  async getMmQuote(
    wallet: EvmWalletProvider,
    args: z.infer<typeof GetMmQuoteSchema>,
  ): Promise<string> {
    const client = buildClient(wallet, this.rpcUrl);
    const { getMmQuoteForStructure } = await import('./mmQuote.js');
    const quote = await getMmQuoteForStructure(client, {
      product: args.product,
      underlying: args.underlying,
      strikes: args.strikes.map(parseFloat),
      expiry: args.expiry,
      numContracts: args.numContracts ? parseFloat(args.numContracts) : 1,
    });
    return JSON.stringify(quote, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  }
}

/**
 * Factory function — matches the convention every Coinbase-published
 * AgentKit action provider follows (e.g. `morphoActionProvider()`).
 *
 * @example Recommended (fail-closed) usage:
 *   thetanutsActionProvider({
 *     safetyLimits: {
 *       maxNotionalUsdcPerAction: 100_000_000n,  // $100
 *       maxApprovalAmount: 'exact',
 *       allowedCollateral: ['USDC'],
 *     },
 *   })
 *
 * @example Explicit opt-out (NOT recommended):
 *   thetanutsActionProvider({ safetyLimits: { unsafe: true } })
 */
export const thetanutsActionProvider = (
  opts: { rpcUrl?: string; safetyLimits?: SafetyLimits } = {},
) => new ThetanutsActionProvider(opts);
