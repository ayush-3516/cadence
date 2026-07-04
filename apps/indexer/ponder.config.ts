import { createConfig } from "ponder";
import { readFileSync } from "node:fs";
import { subscriptionManagerAbi } from "../../packages/shared/abis/SubscriptionManager.js";

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
