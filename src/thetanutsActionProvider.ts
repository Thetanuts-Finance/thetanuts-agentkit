import type { z } from 'zod';
import {
  ActionProvider,
  CreateAction,
  type EvmWalletProvider,
  type Network,
} from '@coinbase/agentkit';
import {
  ApproveSchema,
  FillOrderSchema,
  RequestRfqSchema,
  MakeOfferSchema,
  SettleRfqSchema,
  SettleRfqEarlySchema,
  CancelRfqSchema,
  CancelOfferSchema,
  GetUserPositionsSchema,
  GetRfqSchema,
  GetMarketPricesSchema,
} from './schemas.js';
import { buildClient, BASE_CHAIN_ID, safeGetAddress } from './sdk.js';
import { SafetyPolicy, isSafetyError, type SafetyLimits } from './safety.js';

const MAX_UINT256 = (1n << 256n) - 1n;

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
      'Approve an ERC20 spender (typically the OptionBook or OptionFactory) for a given amount of a token. Required before fill_order on tokens without active allowance, and before SELL RFQs that require collateral. The actual amount approved respects the configured maxApprovalAmount policy: "exact" approves the requested amount, a bigint caps it, "unlimited" approves MAX_UINT256.',
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
  // OptionBook — limit orderbook
  // ====================================================================

  @CreateAction({
    name: 'fill_order',
    description:
      'Fill a resting order on the Thetanuts OptionBook orderbook. Provide the order index (from the State API or read-only MCP `fetch_orders`) and optionally the USDC amount to spend (omit to fill the maximum available, subject to the configured notional cap). Automatically broadcasts an approval first if the wallet lacks sufficient allowance on the order collateral, respecting the maxApprovalAmount policy.',
    schema: FillOrderSchema,
  })
  async fillOrder(wallet: EvmWalletProvider, args: z.infer<typeof FillOrderSchema>): Promise<string> {
    return this.withSafety(async () => {
      const client = buildClient(wallet, this.rpcUrl);
      const orders = await client.api.fetchOrders();
      const order = orders[args.orderId];
      if (!order) return `Order index ${args.orderId} not found on the orderbook.`;
      const collateralToken = order.order.collateralToken;
      if (!collateralToken) return `Order ${args.orderId} is missing collateralToken; cannot determine approval target.`;

      const usdcAmount = args.usdcAmount ? BigInt(args.usdcAmount) : undefined;
      const encoded = client.optionBook.encodeFillOrder(order, usdcAmount, args.referrer);
      const spendAmount = usdcAmount ?? order.order.numContracts * order.order.price;

      // Safety gate on the fill itself. Treats spendAmount as USDC-base-
      // units; over-conservative for non-USDC collateral by design.
      this.safety.assertAllowed({
        action: 'fillOrder',
        token: collateralToken as `0x${string}`,
        spender: encoded.to as `0x${string}`,
        amount: spendAmount,
        isApproval: false,
      });

      const walletAddr = await safeGetAddress(wallet);
      const allowance = await client.erc20.getAllowance(collateralToken, walletAddr, encoded.to);
      let approveTx: `0x${string}` | undefined;
      if (allowance < spendAmount) {
        // The approve sub-action gets its own safety check (separate
        // action type so hosts can audit differently).
        this.safety.assertAllowed({
          action: 'approve',
          token: collateralToken as `0x${string}`,
          spender: encoded.to as `0x${string}`,
          amount: spendAmount,
          isApproval: true,
        });
        const approvalAmount = this.safety.approvalAmount(spendAmount);
        const approveEnc = client.erc20.encodeApprove(collateralToken, encoded.to, approvalAmount);
        approveTx = (await wallet.sendTransaction({
          to: approveEnc.to as `0x${string}`,
          data: approveEnc.data as `0x${string}`,
        })) as `0x${string}`;
        await wallet.waitForTransactionReceipt(approveTx);
      }

      const fillTx = (await wallet.sendTransaction({
        to: encoded.to as `0x${string}`,
        data: encoded.data as `0x${string}`,
      })) as `0x${string}`;
      await wallet.waitForTransactionReceipt(fillTx);

      return [
        approveTx ? `Approved ${collateralToken} for OptionBook. tx=${approveTx}` : 'Allowance already sufficient.',
        `Filled order ${args.orderId}. tx=${fillTx}`,
      ].join(' ');
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
      const offerDeadlineMinutes = Math.max(
        1,
        Math.floor((args.offerEndTimestamp - Math.floor(Date.now() / 1000)) / 60),
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
    return JSON.stringify(prices, null, 2);
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
