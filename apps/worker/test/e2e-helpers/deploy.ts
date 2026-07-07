import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ANVIL_DEFAULT_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface DeployedContracts {
  subscriptionManager: `0x${string}`;
  feeRegistry: `0x${string}`;
  usdc: `0x${string}`;
  treasury: `0x${string}`;
}

export function deployContracts(rpcUrl: string): DeployedContracts {
  const contractsDir = path.resolve(__dirname, "../../../../packages/contracts");

  execSync(`forge script script/DeployLocal.s.sol --rpc-url ${rpcUrl} --broadcast`, {
    cwd: contractsDir,
    env: { ...process.env, DEPLOYER_PRIVATE_KEY: ANVIL_DEFAULT_DEPLOYER_KEY },
    stdio: "inherit",
  });

  // Read forge's own broadcast artifact — NOT the shared deployments/84532.json.
  // DeployLocal.s.sol (Step 0 of this task) never writes to that file at all;
  // it exists purely so apps/indexer and apps/api's real dev setup is never
  // touched by a throwaway test deployment.
  const broadcastPath = path.join(contractsDir, "broadcast/DeployLocal.s.sol/84532/run-latest.json");
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf-8")) as {
    transactions: { contractName: string; contractAddress: string }[];
  };

  function addressOf(contractName: string): `0x${string}` {
    const tx = broadcast.transactions.find((t) => t.contractName === contractName);
    if (!tx) throw new Error(`No deployed contract named ${contractName} found in broadcast artifact`);
    return tx.contractAddress as `0x${string}`;
  }

  // DeployLocal.s.sol deploys SubscriptionManager behind an ERC1967Proxy — the
  // proxy IS the address callers use. Forge's broadcast JSON records each
  // CREATE transaction under the name of the contract actually being
  // constructed, so the proxy deployment is recorded as "ERC1967Proxy" (twice —
  // once for FeeRegistry's proxy, once for SubscriptionManager's), NOT as
  // "SubscriptionManager". The deployment order in DeployLocal.s.sol is fixed
  // (MockUSDC, then FeeRegistry impl+proxy, then SubscriptionManager
  // impl+proxy), so the SECOND ERC1967Proxy transaction in broadcast order is
  // always the SubscriptionManager proxy.
  //
  // Verified against a real run's broadcast JSON (2026-07-06): transaction
  // order was [MockUSDC, FeeRegistry, ERC1967Proxy (FeeRegistry's), Subscription
  // Manager, ERC1967Proxy (SubscriptionManager's)] — i.e. exactly 2 ERC1967Proxy
  // entries, and the second one's address matched the "SubscriptionManager
  // (proxy)" address printed by the script's own console2.log. The index-based
  // lookup below is confirmed correct, not just assumed.
  const proxyDeployments = broadcast.transactions.filter((t) => t.contractName === "ERC1967Proxy");
  if (proxyDeployments.length < 2) {
    throw new Error(
      `Expected 2 ERC1967Proxy deployments (FeeRegistry, SubscriptionManager) in broadcast artifact, found ${proxyDeployments.length}`,
    );
  }

  return {
    subscriptionManager: proxyDeployments[1].contractAddress as `0x${string}`,
    feeRegistry: proxyDeployments[0].contractAddress as `0x${string}`,
    usdc: addressOf("MockUSDC"),
    treasury: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // anvil default account #0 — DeployLocal.s.sol's deployer, matching Deploy.s.sol's own deployer-as-treasury-placeholder convention for Phase 0
  };
}
