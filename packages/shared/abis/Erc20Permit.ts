// Minimal EIP-2612 permit ABI fragment — only the functions this codebase's
// /v1/prepare/subscribe endpoint needs to read (name, nonces) or reference
// (permit, for calldata shape parity with SubscriptionManager's own ABI
// style). `version()` (EIP-5267) is deliberately NOT included here — not
// every ERC-20 exposes it uniformly, so PrepareService reads it via a raw
// eth_call with a one-off inline ABI fragment and falls back to "1" on
// revert, rather than depending on a function that might not exist.
export const erc20PermitAbi = [
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ name: "", type: "string", internalType: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "permit",
    inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "spender", type: "address", internalType: "address" },
      { name: "value", type: "uint256", internalType: "uint256" },
      { name: "deadline", type: "uint256", internalType: "uint256" },
      { name: "v", type: "uint8", internalType: "uint8" },
      { name: "r", type: "bytes32", internalType: "bytes32" },
      { name: "s", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
