import type { PublicClient, WalletClient } from "viem";
import { subscriptionManagerAbi } from "../../../packages/shared/abis/SubscriptionManager.js";
import type { NonceManager } from "./nonce-manager.js";

export interface ChargeSubmitterDeps {
  walletClient: WalletClient;
  publicClient: PublicClient;
  subscriptionManagerAddress: `0x${string}`;
  nonceManager: NonceManager;
}

export async function submitCharge(deps: ChargeSubmitterDeps, onchainSubId: string): Promise<{ txHash: `0x${string}` }> {
  const { maxFeePerGas, maxPriorityFeePerGas } = await deps.publicClient.estimateFeesPerGas();

  const txHash = await deps.walletClient.writeContract({
    address: deps.subscriptionManagerAddress,
    abi: subscriptionManagerAbi,
    functionName: "charge",
    args: [BigInt(onchainSubId)],
    nonce: deps.nonceManager.next(),
    maxFeePerGas,
    maxPriorityFeePerGas,
    chain: null,
    account: deps.walletClient.account!,
  });

  await deps.publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash };
}
