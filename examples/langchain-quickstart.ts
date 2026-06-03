/**
 * LangChain quickstart for @thetanuts-finance/agentkit.
 *
 * A minimal agent that:
 *  1. Holds its own CDP-managed Base wallet.
 *  2. Reads the orderbook + IV surface from Thetanuts.
 *  3. Submits an RFQ for a put option.
 *  4. Settles when an acceptable offer arrives.
 *
 * Setup:
 *   npm install langchain @langchain/anthropic @coinbase/agentkit \
 *               @coinbase/agentkit-langchain \
 *               @thetanuts-finance/agentkit \
 *               @thetanuts-finance/thetanuts-client
 *
 *   export CDP_API_KEY_ID=...
 *   export CDP_API_KEY_SECRET=...
 *   export CDP_WALLET_SECRET=...
 *   export ANTHROPIC_API_KEY=...
 *
 * Run:
 *   npx tsx examples/langchain-quickstart.ts
 */

import { AgentKit, CdpEvmWalletProvider } from '@coinbase/agentkit';
import { getLangChainTools } from '@coinbase/agentkit-langchain';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatAnthropic } from '@langchain/anthropic';
import { thetanutsActionProvider } from '@thetanuts-finance/agentkit';

async function main() {
  // 1. Wallet provider. CDP Wallet manages the key inside Coinbase's MPC
  //    network — the agent never sees the private key material.
  const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    walletSecret: process.env.CDP_WALLET_SECRET!,
    networkId: 'base-mainnet',
  });

  // 2. AgentKit with our Thetanuts action provider.
  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [
      thetanutsActionProvider({
        // Override the default public RPC for production reliability.
        rpcUrl: process.env.BASE_RPC_URL,
        // Required — every write action fails closed without safetyLimits.
        // These are sensible v1 defaults: $100 per action, exact approvals,
        // USDC-only. Tighten / loosen for your operational risk tolerance.
        safetyLimits: {
          maxNotionalUsdcPerAction: 100_000_000n,
          maxApprovalAmount: 'exact',
          allowedCollateral: ['USDC'],
          // Example host hook — log every attempted write before allowing.
          onWriteAction: (ctx) => {
            console.log('[safety]', ctx.action, ctx.amount.toString(), ctx.token);
            return 'allow';
          },
        },
      }),
    ],
  });

  // 3. LangChain tools + a ReAct agent.
  const tools = await getLangChainTools(agentkit);
  const llm = new ChatAnthropic({ model: 'claude-opus-4-7', temperature: 0 });
  const agent = createReactAgent({ llm, tools });

  // 4. Drive it.
  const response = await agent.invoke({
    messages: [
      {
        role: 'user',
        content:
          'Check the current ETH price via get_market_prices. Then create an RFQ to BUY 0.1 ETH ' +
          'put options with strikes that are 10% out-of-the-money, expiring in 7 days, ' +
          'with a 60-minute offer window. Use USDC collateral. Report the quotation ID.',
      },
    ],
  });

  console.log('--- agent output ---');
  for (const message of response.messages) {
    console.log(`[${message.getType()}]`, message.content);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
