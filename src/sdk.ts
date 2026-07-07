import { JsonRpcProvider } from 'ethers';
import { isAddress, getAddress as toChecksumAddress } from 'viem';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { EvmWalletProvider } from '@coinbase/agentkit';

export const BASE_CHAIN_ID = 8453;

/**
 * Build a ThetanutsClient that reads state via the AgentKit wallet's
 * underlying public client. We deliberately do NOT pass the agent's signer
 * into the SDK — instead the ActionProvider uses the SDK's `encode*`
 * helpers and calls `wallet.sendTransaction(...)` directly. That way the
 * SDK never needs to know about CDP/viem/Privy wallet shape; only one
 * (well-tested) integration point (the AgentKit `EvmWalletProvider`)
 * actually signs.
 *
 * @param wallet - AgentKit wallet provider (CDP / viem / Privy / server)
 * @param rpcUrl - JSON-RPC URL. Defaults to Base mainnet's public RPC.
 *                 For anything serious, supply Alchemy / QuickNode / Infura.
 */
export function buildClient(wallet: EvmWalletProvider, rpcUrl?: string): ThetanutsClient {
  const network = wallet.getNetwork();
  if (network.protocolFamily !== 'evm' || Number(network.chainId) !== BASE_CHAIN_ID) {
    throw new Error(
      `ThetanutsActionProvider only supports Base mainnet (chainId 8453); ` +
        `wallet is on chainId=${network.chainId} (${network.networkId}).`,
    );
  }

  // The SDK requires an ethers Provider for read calls. We instantiate a
  // separate JsonRpcProvider rather than wrapping the AgentKit
  // PublicClient — that wrapping is non-trivial and the read cost is
  // negligible compared to LLM round-trips.
  const provider = new JsonRpcProvider(rpcUrl ?? 'https://mainnet.base.org');

  // Optional referrer for RFQ fee sharing. When THETANUTS_REFERRER is a valid
  // address, the SDK attributes RFQ referral to it so accrued fees can be
  // claimed to that wallet (see claimFees / getFactoryReferrerStats). Inert
  // until Thetanuts enables a non-zero fee split for the address — harmless
  // when unset (behaves exactly as before). Never throws on a bad value: an
  // invalid referrer must not break trade execution, so we just skip it.
  const referrerRaw = process.env.THETANUTS_REFERRER?.trim();
  const referrer =
    referrerRaw && /^0x[0-9a-fA-F]{40}$/.test(referrerRaw) ? referrerRaw : undefined;

  return new ThetanutsClient({
    chainId: BASE_CHAIN_ID,
    provider,
    ...(referrer ? { referrer } : {}),
    // No signer. Writes go through wallet.sendTransaction(); the SDK only
    // builds calldata.
  });
}

/**
 * Resolve the human-readable strike(s) to BigInt with 8-decimal scaling
 * to match the OptionFactory contract's expectation. Used by request_rfq.
 */
export function scaleStrikes(strikes: string[]): bigint[] {
  return strikes.map((s) => {
    const [whole, frac = ''] = s.split('.');
    const padded = (frac + '00000000').slice(0, 8);
    return BigInt(whole + padded);
  });
}

/** Eight decimals (price scale used by OptionFactory). */
export const PRICE_SCALE = 100_000_000n;

/**
 * Validate + checksum-normalize the address a custom wallet provider
 * reports. A misbehaving provider that returns whitespace, lowercase
 * non-checksummed strings, or a different address than it signs with
 * would otherwise cause the agent to embed a bogus `requester`/`offeror`
 * into calldata + EIP-712 messages. Failing closed prevents on-chain
 * confusion and reverts that only manifest after gas is burned.
 */
export async function safeGetAddress(wallet: EvmWalletProvider): Promise<`0x${string}`> {
  const raw = await wallet.getAddress();
  if (typeof raw !== 'string' || !isAddress(raw)) {
    throw new Error(
      `Wallet provider returned an invalid address: ${JSON.stringify(raw)}. ` +
        'Verify the EvmWalletProvider implementation.',
    );
  }
  return toChecksumAddress(raw);
}
