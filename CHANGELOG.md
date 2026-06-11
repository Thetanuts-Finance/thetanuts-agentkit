# Changelog

## 0.2.0 — drop OptionBook from agent surface

**Breaking** — removes the `fill_order` action.

OptionBook fills are not exposed in v0.2 because the silent-rejection failure mode (maker offline, indexer lag, race-loss) creates a poor first-trade UX for autonomous agents. RFQ is the only write path. If you need OptionBook fills, use the SDK's `optionBook.encodeFillOrder` directly — that surface is unchanged.

- Removed: `fill_order` `@CreateAction` method
- Removed: `FillOrderSchema` + `FillOrderArgs` public exports
- Removed: `fillOrder` from `SafetyActionType` enum
- Updated: `approve` description no longer mentions OptionBook
- Updated: README action table + safety section
- Added: `SafetyPolicy` unit test suite (`tests/safety.test.mjs`, runs via `node --test` against the compiled `dist/` so it exercises the published artifact) — covers the fail-closed default, notional cap, collateral allowlist, `onWriteAction` hook ordering, and `approvalAmount` policy
- Added: `examples/mcp-server-quickstart.ts` — run the ActionProvider as an autonomous-signing MCP server via Coinbase's official `@coinbase/agentkit-model-context-protocol` adapter (CDP wallet, `SafetyPolicy` as the only brake). Deliberately a separate artifact from `@thetanuts-finance/mcp`, which never signs.
- Added: GitHub Actions CI — typecheck + test suite on every push and PR. CI builds `thetanuts-client` from source (sibling checkout, same layout as local dev) because the SDK APIs this package uses don't exist in any published SDK version yet.
- **Breaking (manifest):** `@thetanuts-finance/thetanuts-client` peer floor raised from `>=0.2.5` to `>=0.3.0`. CI's first run caught that `make_offer` / `settle_rfq_early` call `buildOfferTypedData`, `getRequesterPublicKey`, and `getOffer` — none of which exist in the published 0.2.5. This package must not be published to npm before SDK 0.3.0 is.
- Removed: broken `lint` script (`eslint` was never a dependency).
- Docs: README no longer uses internal "Phase A / Phase B" naming — replaced with plain language (user-in-the-loop Base MCP plugin vs this autonomous package); framework list corrected to the adapters that actually exist for TypeScript (LangChain, Vercel AI SDK, MCP); fixed the action-surface count (7 write actions — `make_offer_with_signature` never existed).

Action surface now: 7 write actions (`approve`, `request_rfq`, `make_offer`, `settle_rfq`, `settle_rfq_early`, `cancel_rfq`, `cancel_offer`) + 3 read actions (`get_user_positions`, `get_rfq`, `get_market_prices`).

## 0.1.4 — 30-second default RFQ offer window

- `request_rfq`: `offerEndTimestamp` is now optional. Defaults to `now + 30 seconds` when omitted. Rationale: a short default lets agents discover MM interest quickly instead of waiting through a long window for silence. The contract enforces no minimum (REVEAL_WINDOW only constrains expiry vs offer-end; the live r12 REVEAL_WINDOW is 60s), so the default is contract-safe for any sensible option expiry.
- Callers can override (e.g. `offerEndTimestamp: now + 300` for a 5-minute window).

## 0.1.2 — sync with current @coinbase/agentkit API

- Bump `@coinbase/agentkit` peerDependency to `>=0.10.0` (was `>=0.5.0`; the published v0.10.x API renamed `CdpWalletProvider` → `CdpEvmWalletProvider` and changed the configure-with-wallet field names from `apiKeyName` / `apiKeyPrivateKey` to `apiKeyId` / `apiKeySecret` / `walletSecret`).
- Update README + both quickstarts to use the new class and field names.
- No runtime API changes in this package itself.

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
