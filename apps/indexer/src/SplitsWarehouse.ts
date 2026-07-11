import { ponder } from "ponder:registry";
import { onchainSplit, onchainPayout } from "ponder:schema";
import { getAddress } from "viem";

// ERC6909's token-ID convention is uint256(uint160(tokenAddress)) — the
// low 160 bits of the ID, reinterpreted as an address. Confirmed against
// 0xSplits' SplitsWarehouse source (interfaces/IERC6909.sol) during
// brainstorming.
function tokenIdToAddress(id: bigint): string {
  const hex = id.toString(16).padStart(40, "0").slice(-40);
  return getAddress(`0x${hex}`);
}

export async function handleSplitCreated({ event, context }: { event: any; context: any }) {
  await context.db.insert(onchainSplit).values({
    address: event.args.split,
    chainId: context.chain.id,
    createdAt: new Date(Number(event.block.timestamp) * 1000),
  });
}

export async function handleWarehouseTransfer({ event, context }: { event: any; context: any }) {
  const split = await context.db.find(onchainSplit, { address: event.args.sender });
  if (!split) return; // not a known Split — ignore (e.g. an unrelated Warehouse deposit/transfer)

  await context.db.insert(onchainPayout).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    splitAddress: event.args.sender,
    recipient: event.args.receiver,
    token: tokenIdToAddress(event.args.id),
    amount: event.args.amount.toString(),
    usdValue: null,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    chainId: context.chain.id,
    distributedAt: new Date(Number(event.block.timestamp) * 1000),
  });
}

ponder.on("PullSplitFactoryV2o2:SplitCreated", handleSplitCreated);
ponder.on("SplitsWarehouse:Transfer", handleWarehouseTransfer);
