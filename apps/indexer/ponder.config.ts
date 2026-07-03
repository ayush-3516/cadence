import { createConfig } from "ponder";
import { readFileSync } from "node:fs";
import type { Abi } from "viem";
import subscriptionManagerAbiJson from "../../packages/shared/abis/SubscriptionManager.json" with { type: "json" };

const subscriptionManagerAbi = subscriptionManagerAbiJson as Abi;

const deployment = JSON.parse(
  readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf-8"),
);

export default createConfig({
  chains: {
    anvilLocal: {
      id: 84532,
      rpc: process.env.PONDER_RPC_URL_84532,
    },
  },
  contracts: {
    SubscriptionManager: {
      chain: "anvilLocal",
      abi: subscriptionManagerAbi,
      address: deployment.subscriptionManager,
      startBlock: 43659613,
    },
  },
});
