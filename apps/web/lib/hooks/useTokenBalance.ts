import { useReadContract } from "wagmi";
import { erc20Abi } from "viem";

export function useTokenBalance(tokenAddress: `0x${string}` | undefined, account: `0x${string}` | undefined) {
  const { data, isLoading } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: tokenAddress !== undefined && account !== undefined },
  });
  return { balance: data, isLoading };
}
