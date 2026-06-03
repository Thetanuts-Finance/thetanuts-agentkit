# Changelog

## 0.1.1 — Phase B audit closeout

Five findings from the AgentKit security audit, four addressed here:

| # | Title | Status |
|---|---|---|
| AKIT-001 | No notional / spend ceiling on writes | ✅ Fixed — `SafetyPolicy` enforces `maxNotionalUsdcPerAction`, `maxApprovalAmount`, `allowedCollateral`, and `onWriteAction` hook. Default is fail-closed: writes throw `SAFETY_LIMITS_REQUIRED` if no policy is configured. |
| AKIT-002 | `get_rfq` leaks encrypted offer ciphertexts into LLM context | ✅ Fixed — `get_rfq` now returns offer summaries only (offeror, status, createdAt, revealedAmount), strips `signedOfferForRequester` and `signingKey`. |
| AKIT-003 | Untrusted `wallet.getAddress()` flows into typed-data signing | ✅ Fixed — new `safeGetAddress` helper in `src/sdk.ts` uses viem's `isAddress` + checksum normalization. Applied at every `getAddress()` site. |
| AKIT-004 | Unused `Wallet` import in `sdk.ts` | ✅ Fixed — removed. |
| AKIT-005 | Inherited Solana-side vulns via `@coinbase/agentkit` | Track upstream — not reachable from EVM-only code path. |

### Breaking change

`thetanutsActionProvider({ ... })` now requires `safetyLimits` for write actions. Existing 0.1.0 callers must either:

- Pass concrete limits (recommended): `safetyLimits: { maxNotionalUsdcPerAction: ..., maxApprovalAmount: 'exact', allowedCollateral: ['USDC'] }`
- Opt in to 0.1.0 behavior: `safetyLimits: { unsafe: true }` (logs a warning)

Read actions (`get_user_positions`, `get_rfq`, `get_market_prices`) and stateless actions (`settle_rfq`, `settle_rfq_early`, `cancel_rfq`, `cancel_offer`) are unaffected — they don't move funds even under prompt injection.

### New exports

- `SafetyPolicy`, `SafetyLimits`, `SafetyContext`, `SafetyActionType`, `isSafetyError`
- `safeGetAddress(wallet)` helper for downstream code that wants the same address-validation guarantee.

## 0.1.0 — Phase B initial release

First release. Sibling repo to `Thetanuts-Finance/thetanuts-sdk` providing a Coinbase AgentKit ActionProvider for autonomous backend agents.

### Features

- `ThetanutsActionProvider` class + `thetanutsActionProvider()` factory.
- 8 write actions: `approve`, `fill_order`, `request_rfq`, `make_offer`, `settle_rfq`, `settle_rfq_early`, `cancel_rfq`, `cancel_offer`.
- 3 read actions: `get_user_positions`, `get_rfq`, `get_market_prices`.
- Zod schemas for every action with LLM-friendly descriptions.
- Runnable LangChain + Vercel AI SDK quickstarts under `examples/`.
- Base mainnet (chainId 8453) only — provider rejects other networks.

### Architecture

- Reuses `@thetanuts-finance/thetanuts-client` `encode*` helpers — no contract logic duplicated.
- Uses `optionFactory.buildOfferTypedData(...)` (added in SDK v0.3.0) for EIP-712 offer signing; SDK verifies live `OFFER_TYPEHASH` and fails closed on drift.
- Read State API path for `requesterPublicKey` and encrypted offer recovery (added in SDK v0.3.0) — no contract reads beyond what the SDK already exposes.

### Out of scope (deferred to 0.2.x)

- `swap_and_fill`, `swap_and_call`.
- Vault deposit/withdraw.
- Loan flows.
- Ethereum mainnet (chainId 1).
