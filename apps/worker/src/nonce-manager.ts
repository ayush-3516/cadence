import type { PublicClient } from "viem";

export interface NonceManager {
  next(): number;
}

export async function createNonceManager(publicClient: PublicClient, relayerAddress: `0x${string}`): Promise<NonceManager> {
  let currentNonce = await publicClient.getTransactionCount({ address: relayerAddress, blockTag: "pending" });

  return {
    next(): number {
      const nonce = currentNonce;
      currentNonce += 1;
      return nonce;
    },
  };
}
