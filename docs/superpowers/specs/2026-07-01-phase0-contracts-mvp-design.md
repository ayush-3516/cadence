# Phase 0 — Contracts MVP: Design

**Date:** 2026-07-01
**Status:** Approved for planning
**Source:** `cadence-prd.md` §6, §11 (Phase 0), Appendix C; `web3-billing-platform-blueprint.md` §5

## 1. Purpose

Build the on-chain core of Cadence: a non-custodial, allowance/permit-based subscription
billing engine (PRD Option 2 / blueprint §3 Option 2), plus a showcase revenue splitter,
deployed and verified on Base Sepolia. This is the first of four phased sub-projects
(Phase 0 → 1 → 2 → 3); later phases (indexer, API, scheduler, dashboard, account
abstraction) are out of scope here and will get their own spec/plan cycles.

This phase is self-contained: it produces `packages/contracts` as a working Foundry
project with no dependency on any backend or frontend code. It also lays down the empty
monorepo skeleton so later phases don't require restructuring.

## 2. Non-goals (explicitly deferred)

- Indexer, API, scheduler, dashboard, customer portal, SDK — Phase 1+.
- ERC-4337 / ERC-7715 / paymaster / session-key validator — Phase 2.
- Streaming (Superfluid), multi-chain, keeper incentives, refunds — Phase 3.
- Real Safe multisig — Phase 0 uses the deployer EOA as Timelock proposer/executor;
  swapping in a real Safe is a config change for a later phase, not a contract change.
- External security audit — required before mainnet only (§6.10), not for Sepolia.

## 3. Monorepo skeleton (created now, filled in later)

Per PRD §4.1, create the full folder layout with minimal stub `package.json`s
(name + version only) so later phases drop in without restructuring:

```
cadence/
├── apps/{web,api,indexer,worker}/         # stub package.json only
├── packages/
│   ├── contracts/                          # REAL CONTENT THIS PHASE
│   ├── sdk/                                # stub
│   ├── db/                                 # stub
│   ├── shared/                             # stub (will hold ABIs later)
│   └── ui/                                 # stub
├── deployments/                            # written by Deploy.s.sol
├── docker-compose.yml                      # Postgres + Redis + anvil (for later phases)
├── turbo.json
├── pnpm-workspace.yaml
└── .gitignore
```

No scripts/dependencies wired for the stub packages yet — just enough structure that
`pnpm-workspace.yaml` resolves and Phase 1 can add real content without moving files.

## 4. Contracts (`packages/contracts`, Foundry)

Framework: Foundry (installed: v1.7.1). Solidity `^0.8.24`. Libraries: OpenZeppelin
Contracts Upgradeable, Solady, SafeERC20 (via OZ).

### 4.1 `FeeRegistry` (UUPS upgradeable)
- `defaultFeeBps` (uint16) + per-merchant `Override{bool set; uint16 bps}`.
- `getFeeBps(address merchant) view returns (uint16)` — capped at `MAX_FEE_BPS = 1000`.
- Admin setters (`setDefaultFeeBps`, `setMerchantFee`, `clearMerchantFee`), all timelock-gated,
  all capped at `MAX_FEE_BPS`, emitting `DefaultFeeUpdated` / `MerchantFeeUpdated`.
- Exact spec: PRD §6.6.

### 4.2 `SubscriptionManager` (UUPS upgradeable)
Single contract owning both plan registry and subscription lifecycle (per PRD §6.2 — the
blueprint's separate `PlanRegistry` is superseded by the PRD's merged design; PRD wins as
it's the more detailed/authoritative spec).

- **State:** `Plan`/`Subscription` structs, `Status` enum, mappings, `nextPlanId`/`nextSubId`,
  `treasury`, `feeRegistry`, `MAX_FEE_BPS`, storage gap — verbatim from PRD §6.2.
- **Errors:** verbatim from PRD §6.3.
- **Events:** verbatim from PRD §6.4 (frozen interface — indexer will depend on exact
  names/params in Phase 1).
- **Functions:** verbatim signatures from PRD §6.5 and Appendix C.1, applying the
  Appendix C.0 naming correction (`pauseSubscription`/`resumeSubscription` for the
  subscriber-facing freeze, distinct from the Pausable circuit breaker `pause()`/`unpause()`).
  Includes `subscribeWithPermit` (EIP-2612) and `subscribeWithPermit2` (Permit2 fallback
  for tokens without 2612).
- **Charging semantics (critical, from §6.5):**
  - `charge`/`chargeBatch` are permissionless.
  - Insufficient balance/allowance is a **non-reverting** path → `PastDue` + `ChargeFailed`;
    period does NOT advance. This must not revert, so one failure in `chargeBatch` can't
    roll back others.
  - Period drift rule: `newPeriodEnd = max(currentPeriodEnd, block.timestamp) + period`
    (no retroactive catch-up charging).
  - A failing first charge on `subscribe` (no-trial path) reverts the whole subscription
    (no half-open state).
  - `nonReentrant` + `whenNotPaused` on `subscribe*`/`charge`/`chargeBatch`.
- **Roles:** `AccessControlUpgradeable` — `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE`,
  `PAUSER_ROLE`, all initially granted to a `TimelockController` (48h min delay).
- **Upgradeability:** UUPS, `_authorizeUpgrade` gated on `UPGRADER_ROLE`, storage gap
  reserved, layout-safety checked via `forge inspect storageLayout` (wired into CI script
  even though full CI pipeline is a later concern).
- **0xSplits integration:** `payoutSplit` is just an address `SubscriptionManager`
  transfers `net` to — no 0xSplits contracts are deployed or called by our code. For the
  fork test, we create a real Split via the 0xSplits factory on Base Sepolia and use its
  address as `payoutSplit`.

### 4.3 `RevenueSplitter` (showcase, plain/non-upgradeable)
Per PRD Appendix C.5, verbatim: pull-based, reentrancy-guarded, CEI. `createSplit`,
`deposit`, `withdraw`, events, with the stated invariant
`Σ owed + Σ withdrawn == Σ deposited` per (split, token). This is a portfolio artifact
demonstrating Solidity depth — explicitly not wired into `SubscriptionManager`'s
production charging path (README will state this).

### 4.4 Deploy tooling
- `script/Deploy.s.sol`: deploy `FeeRegistry` proxy → `SubscriptionManager` proxy → wire
  fee registry + treasury address + supported token (USDC on Base Sepolia) → deploy a
  `TimelockController` (48h delay, proposer=executor=deployer EOA for Phase 0) → grant
  `DEFAULT_ADMIN_ROLE`/`UPGRADER_ROLE`/`PAUSER_ROLE` to the Timelock → deployer renounces
  its own admin role → write `deployments/84532.json` (addresses + ABI refs).
- Treasury address for Phase 0: the deployer EOA (placeholder; a real treasury/Safe is a
  later config change).
- `script/Upgrade.s.sol`: propose+execute an upgrade via the Timelock (exercised in a test,
  not necessarily run against Sepolia this phase).

## 5. Testing (Foundry, target ≥95% coverage on core contracts)

Per PRD §6.11, all four tiers:

1. **Unit** (`test/unit/`) — one file per contract; every happy path + every revert listed
   in §6.11 (createPlan, subscribe with/without trial, duplicate-sub revert, charge
   on-time/not-due/insufficient-balance/insufficient-allowance/recovery-from-PastDue/
   finalize-pendingCancel, pauseSubscription/resumeSubscription, cancel immediate vs
   at-period-end, access control on every function, token allowlist, fee math exactness).
2. **Fuzz** (`test/fuzz/`) — amount/feeBps/period/trialPeriod/time-warp; assert period
   math never drifts negative, fee ≤ amount, fee+net==amount; many subscribers/plans, no
   cross-contamination.
3. **Invariant** (`test/invariant/`) — a handler-driven suite proving INV-1..INV-5 from
   §6.11 (fee+net conservation, no double-charge per period, terminal states never
   charged, `activeSubOf` consistency, periodEnd monotonicity).
4. **Fork** (`test/fork/`) — fork Base Sepolia; real USDC contract; a real 0xSplits Split
   (created via factory in test setup or a helper script); prove
   `subscribe → charge → net lands in Split → recipient withdraw` and the `permit` flow
   against real USDC.

Also: `forge snapshot` gas baselines for `subscribe`, `charge`, `chargeBatch(50)`
committed to the repo (regression signal for later phases, even without full CI yet).

## 6. Deployment target

Base Sepolia (chainId 84532). Constants (USDC address, 0xSplits factory address, RPC)
sourced from `packages/shared` config per PRD §4.4 — but since `packages/shared` is a
stub this phase, Phase 0 will hold these as constants directly inside
`packages/contracts` (e.g. `script/Config.sol` or a `.env`), with a note that Phase 1
migrates them into `packages/shared/chains.ts` once that package has real content.
**All addresses will be verified against Circle/0xSplits docs before use, not assumed.**

## 7. Definition of Done (mirrors PRD §11 Phase 0 DoD)

- [ ] All §6 functions implemented with exact signatures/events/errors (frozen interface).
- [ ] Unit + fuzz + invariant + fork tests pass; coverage ≥95% on core; gas snapshot committed.
- [ ] §6.10 security checklist satisfied (reentrancy guards, SafeERC20, no unbounded loops,
      non-reverting insufficient-funds path, full-revert on failed first charge, fee cap
      invariant, no double-charge per period, terminal states never charged, timelock-gated
      upgrades, storage-layout check).
- [ ] Deployed + verified on Base Sepolia; `deployments/84532.json` written.
- [ ] `permit` + `charge` + split routing proven against real USDC + a real 0xSplits Split
      in a fork test.
- [ ] Monorepo skeleton in place for all `apps/*` and `packages/*` per §4.1.

## 8. Open items carried forward (not blocking Phase 0)

- Real Safe multisig ownership of the Timelock — swap-in later, no contract change needed.
- `packages/shared` chain-config migration — happens naturally in Phase 1.
- Full CI pipeline (GitHub Actions per §9.4) — Phase 0 will have the scripts/checks
  runnable locally (`forge test`, `forge snapshot`, `forge inspect storageLayout`); wiring
  them into GitHub Actions is deferred, since no other packages exist yet to share a CI
  file with.
