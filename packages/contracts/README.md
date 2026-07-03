# @cadence/contracts

On-chain core of Cadence: a non-custodial, allowance/permit-based subscription
billing engine on Base.

## Contracts

- **`FeeRegistry`** — UUPS upgradeable. Global + per-merchant platform fee (bps),
  capped at 10%, read by `SubscriptionManager` at charge time.
- **`SubscriptionManager`** — UUPS upgradeable. The core contract: merchants
  create plans, customers subscribe (with an ERC-20 allowance or a gasless
  EIP-2612 `permit`), and charges are pulled on a permissionless schedule by
  an off-chain keeper. Net proceeds route to a `payoutSplit` address —
  in production, a [0xSplits](https://splits.org) Split contract that fans
  out to a merchant's collaborators atomically.
- **`RevenueSplitter`** — **portfolio showcase only.** A from-scratch,
  pull-based, reentrancy-guarded revenue splitter written to demonstrate
  Solidity depth (see its NatSpec). **Production billing does not use this
  contract** — `SubscriptionManager.payoutSplit` is wired to an external,
  audited 0xSplits Split instead. Reinventing a splitter for production is
  exactly the kind of "not-invented-here" mistake that ships a reentrancy
  bug; 0xSplits is audited, free (gas-only), and the de facto standard.

## Why allowance/permit, not account abstraction?

Public blockchains are push-only: nothing can pull funds from a wallet
without a standing authorization. `SubscriptionManager` uses the pragmatic,
maximally-compatible path — an ERC-20 allowance (optionally granted
gaslessly via EIP-2612 `permit`) — so it works with any EOA today. A
scoped, capped, ERC-4337 + ERC-7715 account-abstraction flow (one signature,
fully gasless, tighter risk bounds) is the Phase 2 flagship UX; this
allowance model remains the permanent EOA-compatible fallback.

## Development

```bash
forge install
forge build
forge test              # unit + fuzz + invariant + fork
                         # (fork tests call vm.createSelectFork internally, so no
                         # --fork-url flag: combining both causes an op-revm panic
                         # on post-Isthmus OP-stack chains)
forge coverage --report summary
forge snapshot           # regenerate gas baseline
./script/CheckStorageLayout.sh   # before any upgrade
```

## Deployment

```bash
cp .env.example .env   # fill in BASE_SEPOLIA_RPC_URL, BASESCAN_API_KEY, DEPLOYER_PRIVATE_KEY
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify
```

Writes addresses to `../../deployments/<chainId>.json`.

**Governance:** `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`, and `PAUSER_ROLE` are
held by a `TimelockController` (48h minimum delay). On Base Sepolia the
deployer EOA is the Timelock's sole proposer/executor as a testnet
convenience; before any mainnet deploy this must be a real Safe multisig.

## Deferred to a later phase

- **`subscribeWithPermit2`** — the PRD's copy-paste interface (Appendix C.1)
  lists this alongside `subscribeWithPermit`, for tokens without native
  EIP-2612 support. USDC has EIP-2612, so it isn't needed yet; add it if a
  Permit2-only token is allowlisted.
- **`Upgrade.s.sol`** — no upgrade has been performed yet, so there's nothing
  to script. `CheckStorageLayout.sh` (the safety check an upgrade script
  would gate on) is already in place.
