# @thetanuts-finance/agentkit

Coinbase AgentKit ActionProvider for trading Thetanuts options on Base. Lets autonomous backend agents — agents that own their own wallet — request quotations (RFQ), make encrypted sealed-bid offers, and settle, through any AgentKit-supported framework (LangChain, Vercel AI SDK, OpenAI Agents SDK, Eliza, MCP, Pydantic AI, AutoGen).

This is **Phase B** of the Thetanuts agent integration. Phase A (the Base MCP plugin + prepare service, for user-in-the-loop agents) lives in the main SDK repo at `Thetanuts-Finance/thetanuts-sdk/mcp-server/plugins/base-mcp`.

## When to use this vs Base MCP plugin

| Need | Use |
|---|---|
| User signs every transaction in Base Account, agent prepares calldata | **Phase A: Base MCP plugin** |
| Agent runs unattended on a server with its own wallet (CDP, viem, Privy) | **Phase B: this package** |
| Maximum reach — works in Claude Desktop, Cursor, ChatGPT, Codex | **Phase A: Base MCP plugin** |
| Headless trading bot, MM bot, custodied agent vault | **Phase B: this package** |
| Chat client, but the agent signs by itself with its own wallet | **Phase B as an MCP server** — see [Run as an MCP server](#run-as-an-mcp-server-autonomous-signing) |

Both ultimately call the same SDK encode helpers — the difference is who signs.

## Install

```bash
npm install @thetanuts-finance/agentkit @coinbase/agentkit \
            @thetanuts-finance/thetanuts-client
```

For LangChain integration:

```bash
npm install @coinbase/agentkit-langchain @langchain/langgraph @langchain/anthropic
```

For Vercel AI SDK:

```bash
npm install @coinbase/agentkit-vercel-ai-sdk ai @ai-sdk/anthropic
```

## Quickstart

```typescript
import { AgentKit, CdpEvmWalletProvider } from '@coinbase/agentkit';
import { getLangChainTools } from '@coinbase/agentkit-langchain';
import { thetanutsActionProvider } from '@thetanuts-finance/agentkit';

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  walletSecret: process.env.CDP_WALLET_SECRET!,
  networkId: 'base-mainnet',
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    thetanutsActionProvider({
      rpcUrl: process.env.BASE_RPC_URL,
      // REQUIRED — every write action fails closed without this.
      // See "Safety limits" below.
      safetyLimits: {
        maxNotionalUsdcPerAction: 100_000_000n, // $100 cap per action
        maxApprovalAmount: 'exact',             // never grant MAX_UINT256
        allowedCollateral: ['USDC'],            // restrict v1 to USDC
      },
    }),
  ],
});

const tools = await getLangChainTools(agentkit);
// ... wire `tools` into your LangChain ReAct agent.
```

See `examples/langchain-quickstart.ts` and `examples/vercel-ai-sdk-quickstart.ts` for full runnable demos.

## Run as an MCP server (autonomous signing)

Coinbase ships an official MCP adapter for AgentKit — [`@coinbase/agentkit-model-context-protocol`](https://docs.cdp.coinbase.com/agent-kit/core-concepts/model-context-protocol). Combining it with this package turns the ActionProvider into a stdio MCP server whose tools **sign and broadcast on their own** with the agent's CDP wallet, under the configured `SafetyPolicy`:

```ts
const { tools, toolHandler } = await getMcpTools(agentkit); // agentkit holds the wallet + thetanutsActionProvider
// wire into @modelcontextprotocol/sdk Server + StdioServerTransport
```

Full runnable server: `examples/mcp-server-quickstart.ts`.

**This is deliberately a different artifact from [`@thetanuts-finance/mcp`](https://github.com/Thetanuts-Finance/thetanuts-sdk/tree/main/mcp-server).** That server never signs — it builds calldata and the user approves every transaction in Base Account (via Base MCP). This one signs autonomously: there is no per-transaction approval click, so the `SafetyPolicy` caps are the only brake. Run it only with a dedicated, capped wallet. The two servers can be installed side by side — safe default plus explicit autonomous opt-in.

## Actions

All actions take the AgentKit wallet provider as the first argument (injected automatically by AgentKit) and a Zod-validated arg object.

### Trade actions (write)

| Action | Purpose |
|---|---|
| `approve` | Approve an ERC20 spender (the OptionFactory). Bundled automatically by `request_rfq` for SELL positions; use directly only when explicit. |
| `request_rfq` | Create an RFQ for any product (PUT, CALL, spreads, butterflies, condors, iron condor). Encrypts offers automatically using the agent's stored ECDH keypair. |
| `make_offer` | Submit a sealed-bid offer on someone else's RFQ. Signs EIP-712 `Offer` typed-data via the wallet, encrypts the offer body, broadcasts in one tool call. |
| `settle_rfq` | Normal settlement after the offer window closes. |
| `settle_rfq_early` | Accept a specific maker's offer before the window closes. Decrypts the offer locally using the requester's ECDH key. |
| `cancel_rfq` | Cancel the agent's own RFQ. |
| `cancel_offer` | Retract an offer the agent submitted. |

### Read actions

| Action | Purpose |
|---|---|
| `get_user_positions` | List the agent's (or any address's) open option positions. |
| `get_rfq` | Look up an RFQ by ID — parameters, state, hydrated offers. |
| `get_market_prices` | Oracle prices for ETH / BTC / SOL / etc. |

## Wallet providers

Tested against:

- `CdpEvmWalletProvider` — MPC-managed key, agent never sees private material. **Recommended for production.**
- `ViemWalletProvider` — Local key in a viem `Account`. Useful for development.
- `PrivyWalletProvider` — Embedded wallets, server-side.
- Any custom `EvmWalletProvider` subclass that implements `sendTransaction`, `signTypedData`, `signMessage`, `getAddress`, `getNetwork`, `waitForTransactionReceipt`.

The provider must report Base mainnet (`chainId === 8453`). The ActionProvider throws on any other network.

## Architecture

The ActionProvider deliberately does NOT inject the agent's signer into the SDK. Instead it:

1. Builds a `ThetanutsClient` with the SDK's read provider only.
2. Uses the SDK's `encode*` helpers to build calldata.
3. Calls `wallet.sendTransaction({ to, data })` (or `wallet.signTypedData(...)` for EIP-712) directly.

That way only one (well-tested) integration point — the AgentKit `EvmWalletProvider` — actually signs, and the SDK never needs to know about CDP / viem / Privy wallet shape.

For `make_offer`, the EIP-712 envelope is built via `optionFactory.buildOfferTypedData(...)`, which verifies the live on-chain `OFFER_TYPEHASH` against the SDK's pinned `Offer(uint256 quotationId, uint256 offerAmount, address offeror, uint64 nonce)` struct definition. If the struct ever drifts due to a contract upgrade, the SDK throws rather than silently producing a bad signature.

## Safety limits

Every write action runs through an in-band `SafetyPolicy`. The constructor's `safetyLimits` field is **required by default** — if you don't pass one, all three value-moving actions (`approve`, `request_rfq`, `make_offer`) throw `SAFETY_LIMITS_REQUIRED` and the LLM gets a safe refusal message back instead of an unbounded write.

```typescript
interface SafetyLimits {
  // Hard ceiling on per-action notional in USDC base units (6 decimals).
  // 100_000_000n = $100.
  maxNotionalUsdcPerAction?: bigint;

  // Approval cap. 'exact' (default) approves the amount required and no
  // more. A bigint caps it. 'unlimited' restores v0.1.0 MAX_UINT256
  // behavior — logs a warning, NOT recommended.
  maxApprovalAmount?: 'exact' | bigint | 'unlimited';

  // Restrict RFQ creation to specific collateral tokens. Use during
  // early operation.
  allowedCollateral?: ReadonlyArray<'USDC' | 'WETH' | 'cbBTC' | ...>;

  // Per-write callback for host-side audit / per-tx confirmation / multi-sig.
  onWriteAction?: (ctx: SafetyContext) => 'allow' | 'reject';

  // Escape hatch — opt in to v0.1.0 unbounded behavior. Logs a warning.
  unsafe?: boolean;
}
```

Read actions (`get_user_positions`, `get_rfq`, `get_market_prices`) and stateless actions (`settle_rfq`, `settle_rfq_early`, `cancel_rfq`, `cancel_offer`) don't go through the policy — they can't exfiltrate funds even under prompt injection.

The `get_rfq` action sanitizes its response to omit encrypted offer ciphertexts and signing keys — keeping sealed-bid contents out of the LLM transcript (and out of whatever logs / training pipelines the LLM provider runs).

## Other security notes

- **Don't reuse the agent's CDP wallet for unrelated traffic.** A dedicated wallet per agent makes incident response (revoke approvals, drain remaining balance) much simpler.
- **No prompt-injection defense at the protocol layer.** If your agent reads from untrusted sources (web pages, third-party messages), they may contain values for `quotationId` / `offerorAddress` / `strikes` chosen by an adversary. Validate provenance before calling write actions. The safety policy bounds the damage; it doesn't prevent the attempt.
- **Custom wallet providers are trusted.** A malicious `EvmWalletProvider` subclass can still sign with a different key than its `getAddress()` reports. The `safeGetAddress` helper checksum-validates the address but cannot verify the wallet actually signs with the key behind it. Pin wallet provider versions and review what you depend on.

## Out of scope (v1)

- `swap_and_fill`, `swap_and_call` — depend on a third-party swap-quote integration (KyberSwap or 0x).
- Vault deposit/withdraw (`strategyVault`, `wheelVault`).
- Loan flows.
- Ethereum mainnet (chainId 1).

These will land in v0.2.x.

## Development

```bash
npm install
npm run typecheck
npm run build
```

The `@thetanuts-finance/thetanuts-client` dependency is wired to a local `file:../thetanuts-sdk` path in development; publishing scripts swap it to the npm-published version.

## License

MIT
