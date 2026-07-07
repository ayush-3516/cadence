export const feeRegistryAbi = [
  {
    type: "function",
    name: "getFeeBps",
    inputs: [{ name: "merchant", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint16", internalType: "uint16" }],
    stateMutability: "view",
  },
] as const;
