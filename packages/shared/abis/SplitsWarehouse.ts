// Minimal ABI fragment for 0xSplits' SplitsWarehouse (Base Sepolia, fixed
// address 0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8) — only the ERC6909
// Transfer event, which fires once per recipient when a Pull split's
// distribute() calls batchTransfer(). Confirmed against the installed
// @0xsplits/splits-sdk@6.5.0's own warehouse ABI.
export const splitsWarehouseAbi = [
  {
    type: "event",
    anonymous: false,
    name: "Transfer",
    inputs: [
      { name: "caller", type: "address", indexed: false, internalType: "address" },
      { name: "sender", type: "address", indexed: true, internalType: "address" },
      { name: "receiver", type: "address", indexed: true, internalType: "address" },
      { name: "id", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
  },
] as const;
