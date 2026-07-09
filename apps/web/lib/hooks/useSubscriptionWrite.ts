import { useEffect, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { subscriptionManagerAbi } from "@cadence/shared";

export type WriteStatus = "idle" | "confirming" | "pending" | "processing" | "done" | "error";

const SUBSCRIPTION_MANAGER_ADDRESS = (process.env.NEXT_PUBLIC_SUBSCRIPTION_MANAGER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;

export function useSubscriptionWrite(functionName: "cancel" | "pauseSubscription" | "resumeSubscription") {
  const [status, setStatus] = useState<WriteStatus>("idle");
  const { writeContract, data: hash, error: writeError, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (writeError) setStatus("error");
    else if (isPending) setStatus("confirming");
    else if (hash && isConfirming) setStatus("pending");
    else if (isSuccess) setStatus("processing");
  }, [writeError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (status === "processing") {
      const timer = setTimeout(() => setStatus("done"), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  function write(subId: string, extraArgs: unknown[] = []) {
    setStatus("confirming");
    writeContract({
      address: SUBSCRIPTION_MANAGER_ADDRESS,
      abi: subscriptionManagerAbi,
      functionName,
      // `functionName` is a union of three ABI entries with different arities/arg types
      // (cancel(subId, immediate) vs pauseSubscription(subId) / resumeSubscription(subId)),
      // so viem cannot infer a single args tuple type here. The cast is required for a
      // genuinely polymorphic call site; runtime args are still exactly [subId, ...extraArgs].
      args: [BigInt(subId), ...extraArgs] as never,
    });
  }

  return { write, status, error: writeError ?? receiptError ?? null };
}
