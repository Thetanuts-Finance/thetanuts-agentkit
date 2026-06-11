# Setup guide — trade Thetanuts options from Claude, Codex, or Cursor

This guide takes you from zero to an AI agent that trades options on Thetanuts (Base mainnet). Ten minutes if you already have a Coinbase Developer Platform account.

> **Requires `@thetanuts-finance/agentkit` ≥ 0.2.0 on npm** (and `@thetanuts-finance/thetanuts-client` ≥ 0.3.0). If `npm view @thetanuts-finance/agentkit version` returns 404, the package hasn't shipped yet — check back or build from a repo clone.

## Step 0: Pick your route

There are two ways to trade Thetanuts from a chat client. **They are different products with different trust models — pick deliberately.**

| | Route 1: You approve each trade | Route 2: The agent trades by itself |
|---|---|---|
| What runs | [`@thetanuts-finance/mcp`](https://github.com/Thetanuts-Finance/thetanuts-sdk/tree/main/mcp-server) + [Base MCP](https://docs.base.org/ai-agents/quickstart) | This repo's MCP server (below) |
| Who signs | **You**, in Base Account — every transaction shows an approval link | **The agent's CDP wallet**, unattended |
| Wallet needed | Your existing Base Account | A dedicated CDP server wallet you create and fund |
| Safety boundary | Your approval click | Code-level `SafetyPolicy` caps — nothing else |
| Good for | Anyone. Start here. | Users who explicitly want hands-off automation |
| Setup guide | [Base MCP plugin README](https://github.com/Thetanuts-Finance/thetanuts-sdk/tree/main/mcp-server/plugins/base-mcp) | **This document** |

If you're unsure, take Route 1 — it works in Claude Desktop, Claude Code, Cursor, ChatGPT, and Codex, and a transaction can never leave your wallet without your click. The rest of this guide is Route 2: the autonomous server.

## Step 1: CDP prerequisites (the agent's wallet)

The autonomous server signs with a [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) server wallet — the key lives in Coinbase's MPC infrastructure, not on your machine.

1. Create a CDP account at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/).
2. Create an **API key** → note the `API Key ID` and `API Key Secret`.
3. Create a **Wallet Secret** (Server Wallets v2) → note it.
4. You now have the three required env vars:

```bash
export CDP_API_KEY_ID="..."
export CDP_API_KEY_SECRET="..."
export CDP_WALLET_SECRET="..."
```

## Step 2: Install and run the server

```bash
mkdir thetanuts-agent && cd thetanuts-agent
npm init -y
npm install @thetanuts-finance/agentkit @thetanuts-finance/thetanuts-client \
            @coinbase/agentkit @coinbase/agentkit-model-context-protocol \
            @modelcontextprotocol/sdk reflect-metadata tsx
curl -fsSLO https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-agentkit/main/examples/mcp-server-quickstart.ts
```

Smoke-test it (Ctrl-C to stop):

```bash
npx tsx mcp-server-quickstart.ts
# expect: [thetanuts-autonomous] MCP server ready (Base mainnet, CDP wallet, SafetyPolicy active)
```

## Step 3: Fund the wallet

The agent's wallet starts empty. Ask the agent for its address once it's connected (Step 4) — or print it directly:

```bash
npx tsx -e "
const { CdpEvmWalletProvider } = await import('@coinbase/agentkit');
const w = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID, apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET, networkId: 'base-mainnet' });
console.log(await w.getAddress());
"
```

Send it **USDC on Base** (collateral/premium) and a small amount of **ETH on Base** (gas). Fund only what you're prepared to let an autonomous agent spend — see Step 5.

## Step 4: Wire it into your client

All four clients launch the same command: `npx tsx /absolute/path/to/mcp-server-quickstart.ts` with the three CDP env vars.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "thetanuts-autonomous": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/thetanuts-agent/mcp-server-quickstart.ts"],
      "env": {
        "CDP_API_KEY_ID": "...",
        "CDP_API_KEY_SECRET": "...",
        "CDP_WALLET_SECRET": "..."
      }
    }
  }
}
```

Restart Claude Desktop; the tools appear under `thetanuts-autonomous`.

### Claude Code

```bash
claude mcp add thetanuts-autonomous \
  -e CDP_API_KEY_ID="..." \
  -e CDP_API_KEY_SECRET="..." \
  -e CDP_WALLET_SECRET="..." \
  -- npx tsx /absolute/path/to/thetanuts-agent/mcp-server-quickstart.ts
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.thetanuts-autonomous]
command = "npx"
args = ["tsx", "/absolute/path/to/thetanuts-agent/mcp-server-quickstart.ts"]

[mcp_servers.thetanuts-autonomous.env]
CDP_API_KEY_ID = "..."
CDP_API_KEY_SECRET = "..."
CDP_WALLET_SECRET = "..."
```

(Newer Codex versions also support `codex mcp add` from the CLI.)

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project) — same JSON shape as Claude Desktop above.

## Step 5: Set your safety limits BEFORE first trade

Open `mcp-server-quickstart.ts` and read the `safetyLimits` block. **These caps are the only brake — there is no approval click in this mode.**

```ts
safetyLimits: {
  maxNotionalUsdcPerAction: 50_000_000n, // $50 per action. Raise deliberately.
  maxApprovalAmount: 'exact',            // never grant unlimited ERC20 allowance
  allowedCollateral: ['USDC'],           // start USDC-only
},
```

Starter advice:

- Keep `maxNotionalUsdcPerAction` at or below what you'd be comfortable losing to a single bad LLM decision.
- Leave `maxApprovalAmount: 'exact'` — `'unlimited'` restores MAX_UINT256 approvals and is the single most dangerous knob.
- Add an `onWriteAction` hook if you want every write logged or routed through your own review step (return `'reject'` to block).
- The policy fails closed: remove `safetyLimits` entirely and every write action refuses to run.

## Step 6: First trade

Ask your client:

> "Using the thetanuts-autonomous tools, fetch current ETH option prices, then request a quote to sell a covered call on 0.01 ETH at a strike 5% above spot, expiring Friday, USDC collateral. Report the quotation ID and any offers."

The agent will call `get_market_prices` → `request_rfq` → poll `get_rfq` → `settle_rfq_early` when a maker bids. Every value-moving call passes through the `SafetyPolicy` first.

## Security notes (read these)

- **Dedicated wallet, always.** Never point this at a wallet holding funds the agent shouldn't touch. Incident response on a dedicated wallet is "revoke approvals, drain, rotate keys."
- **No per-transaction approval exists in this mode.** If a prompt injection talks your agent into a trade, the `SafetyPolicy` caps the damage per action — it does not prevent the attempt. Don't let the agent read untrusted content in the same session it trades.
- **Secrets live in client configs.** The CDP credentials sit in `claude_desktop_config.json` / `config.toml` in plaintext. Treat those files like a password file; prefer per-agent CDP API keys you can revoke.
- Want the version where nothing moves without your click? That's [Route 1](#step-0-pick-your-route).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm view @thetanuts-finance/agentkit` → 404 | Package not published yet | Build from a repo clone, or wait for the publish |
| `SAFETY_LIMITS_REQUIRED` on every write | No `safetyLimits` configured | That's the fail-closed default working — add limits (Step 5) |
| `wallet provider only supports Base mainnet` | Wrong `networkId` | Use `networkId: 'base-mainnet'` |
| Server starts but client shows no tools | Relative path in client config | Use the **absolute** path to `mcp-server-quickstart.ts` |
| Trades revert with no balance change | Wallet unfunded | Step 3 — USDC + gas ETH on Base |
