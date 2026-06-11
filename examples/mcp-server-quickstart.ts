/**
 * Run the Thetanuts ActionProvider as an MCP server — autonomous signing.
 *
 * This is the "MCP that can trade by itself" deployment. It is NOT
 * @thetanuts-finance/mcp (which never signs — it builds calldata and the
 * user approves each transaction in Base Account via Base MCP). This server
 * holds a CDP server wallet and signs autonomously, restrained only by the
 * SafetyPolicy configured below. Install it deliberately, fund the wallet
 * accordingly, and keep the limits tight.
 *
 *   Want chat trading where you approve each tx?  → @thetanuts-finance/mcp + Base MCP
 *   Want an MCP whose tools sign on their own?    → this file
 *   Want a fully headless bot, no MCP client?     → langchain/vercel quickstarts
 *
 * Setup:
 *   npm install @coinbase/agentkit @coinbase/agentkit-model-context-protocol \
 *               @modelcontextprotocol/sdk \
 *               @thetanuts-finance/agentkit \
 *               @thetanuts-finance/thetanuts-client
 *
 *   export CDP_API_KEY_ID=...
 *   export CDP_API_KEY_SECRET=...
 *   export CDP_WALLET_SECRET=...
 *
 * Run (stdio — wire into Claude Desktop / Cursor as a command server):
 *   npx tsx examples/mcp-server-quickstart.ts
 *
 * Claude Desktop config:
 *   { "mcpServers": { "thetanuts-autonomous": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/examples/mcp-server-quickstart.ts"],
 *       "env": { "CDP_API_KEY_ID": "...", "CDP_API_KEY_SECRET": "...",
 *                "CDP_WALLET_SECRET": "..." } } } }
 */

import { AgentKit, CdpEvmWalletProvider } from '@coinbase/agentkit';
import { getMcpTools } from '@coinbase/agentkit-model-context-protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { thetanutsActionProvider } from '@thetanuts-finance/agentkit';

async function main() {
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
        // The only brake on this server is this policy. There is no
        // per-transaction approval click — size the caps like you mean them.
        safetyLimits: {
          maxNotionalUsdcPerAction: 50_000_000n, // $50
          maxApprovalAmount: 'exact',
          allowedCollateral: ['USDC'],
        },
      }),
    ],
  });

  const { tools, toolHandler } = await getMcpTools(agentkit);

  const server = new Server(
    { name: 'thetanuts-autonomous', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    toolHandler(request.params.name, request.params.arguments),
  );

  await server.connect(new StdioServerTransport());
  // stdio servers must not write to stdout outside the protocol.
  console.error('[thetanuts-autonomous] MCP server ready (Base mainnet, CDP wallet, SafetyPolicy active)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
