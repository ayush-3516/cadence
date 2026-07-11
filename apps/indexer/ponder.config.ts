import { createConfig } from "ponder";
import { readFileSync } from "node:fs";
import { subscriptionManagerAbi } from "../../packages/shared/abis/SubscriptionManager.js";
import { splitV2FactoryAbi } from "../../packages/shared/abis/SplitV2Factory.js";
import { splitsWarehouseAbi } from "../../packages/shared/abis/SplitsWarehouse.js";

const deployment = JSON.parse(
  readFileSync(new URL("../../deployments/84532.json", import.meta.url), "utf-8"),
);

const PULL_SPLIT_FACTORY_V2O2_ADDRESS = "0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1";
const SPLITS_WAREHOUSE_ADDRESS = "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8";

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
      startBlock: 43690474,
    },
    PullSplitFactoryV2o2: {
      chain: "anvilLocal",
      abi: splitV2FactoryAbi,
      address: PULL_SPLIT_FACTORY_V2O2_ADDRESS,
      startBlock: 43690474,
    },
    SplitsWarehouse: {
      chain: "anvilLocal",
      abi: splitsWarehouseAbi,
      address: SPLITS_WAREHOUSE_ADDRESS,
      startBlock: 43690474,
    },
  },
});
