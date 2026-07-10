// Minimal ABI fragment for 0xSplits' PullSplitFactoryV2.2 (Base Sepolia:
// 0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1) — only the SplitCreated event,
// used by apps/indexer's factory-pattern config (Task 3) to discover every
// Split address the factory deploys. Confirmed against the installed
// @0xsplits/splits-sdk@6.5.0's own splitV2o2Factory ABI (the exact factory
// version the SDK's SplitV2Client.createSplit() targets by default).
export const splitV2FactoryAbi = [
  {
    type: "event",
    anonymous: false,
    name: "SplitCreated",
    inputs: [
      { indexed: true, internalType: "address", name: "split", type: "address" },
      {
        indexed: false,
        internalType: "struct SplitV2Lib.Split",
        name: "splitParams",
        type: "tuple",
        components: [
          { internalType: "address[]", name: "recipients", type: "address[]" },
          { internalType: "uint256[]", name: "allocations", type: "uint256[]" },
          { internalType: "uint256", name: "totalAllocation", type: "uint256" },
          { internalType: "uint16", name: "distributionIncentive", type: "uint16" },
        ],
      },
      { indexed: false, internalType: "address", name: "owner", type: "address" },
      { indexed: false, internalType: "address", name: "creator", type: "address" },
      { indexed: false, internalType: "bytes32", name: "salt", type: "bytes32" },
    ],
  },
] as const;
