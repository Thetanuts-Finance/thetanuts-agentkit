/**
 * Vercel AI SDK quickstart for @thetanuts-finance/agentkit.
 *
 * Uses generateText with tool use to let the model drive the Thetanuts
 * actions through any Vercel AI SDK provider (Anthropic shown here).
 *
 * Setup:
 *   npm install ai @ai-sdk/anthropic \
 *               @coinbase/agentkit @coinbase/agentkit-vercel-ai-sdk \
 *               @thetanuts-finance/agentkit \
 *               @thetanuts-finance/thetanuts-client
 *
 *   export CDP_API_KEY_NAME=...
 *   export CDP_API_KEY_PRIVATE_KEY=...
 *   export ANTHROPIC_API_KEY=...
 *
 * Run:
 *   npx tsx examples/vercel-ai-sdk-quickstart.ts
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { AgentKit, CdpWalletProvider } from '@coinbase/agentkit';
import { getVercelAITools } from '@coinbase/agentkit-vercel-ai-sdk';
import { thetanutsActionProvider } from '@thetanuts-finance/agentkit';

async function main() {
  const walletProvider = await CdpWalletProvider.configureWithWallet({
    apiKeyName: process.env.CDP_API_KEY_NAME!,
    apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY!,
    networkId: 'base-mainnet',
  });

  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      thetanutsActionProvider({
        rpcUrl: process.env.BASE_RPC_URL,
        // System prompt also caps at $50 below — the safety policy is the
        // belt under the suspenders. Both layers, always.
        safetyLimits: {
          maxNotionalUsdcPerAction: 50_000_000n, // $50
          maxApprovalAmount: 'exact',
          allowedCollateral: ['USDC'],
        },
      }),
    ],
  });

  const tools = getVercelAITools(agentkit);

  const result = await generateText({
    model: anthropic('claude-opus-4-7'),
    tools,
    maxSteps: 8,
    system:
      'You are an automated options trading agent on Thetanuts (Base mainnet). ' +
      'You may only submit small trades (< 50 USDC notional). ' +
      'Always read market state before placing an RFQ.',
    prompt:
      'Fetch my current Thetanuts positions. If I have none, place a small protective ' +
      'put RFQ on 0.01 ETH at a strike 5% below the current mark, expiring in 3 days. ' +
      'Use a 30-minute offer window and USDC collateral. Report the quotation ID.',
  });

  console.log('--- text ---');
  console.log(result.text);
  console.log('--- tool calls ---');
  console.dir(result.toolCalls, { depth: 4 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
