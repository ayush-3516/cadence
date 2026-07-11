import { useEffect, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { erc20PermitAbi } from "@cadence/shared/abis";

export type RevokeStatus = "idle" | "confirming" | "pending" | "processing" | "done" | "error";

export interface UseRevokeAllowanceResult {
  write: (tokenAddress: string) => void;
  status: RevokeStatus;
  error: Error | null;
}

const SUBSCRIPTION_MANAGER_ADDRESS = (process.env.NEXT_PUBLIC_SUBSCRIPTION_MANAGER_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;

export function useRevokeAllowance(): UseRevokeAllowanceResult {
  const [status, setStatus] = useState<RevokeStatus>("idle");
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const { writeContract, data: hash, error: writeError, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });

  // Gated on hasSubmitted (matching useCreatePlanSubmit.ts's established pattern from an
  // earlier phase) so this effect — not write()'s own synchronous setStatus — is the single
  // source of truth for status once a write has actually been submitted. Without this gate, a
  // test (or a real render where wagmi's mocked/cached state doesn't change across a write)
  // never re-fires the effect after write()'s manual setStatus("confirming"), leaving status
  // stuck instead of reflecting the real (already-resolved) wagmi state.
  useEffect(() => {
    if (!hasSubmitted) return;
    if (writeError) setStatus("error");
    else if (isPending) setStatus("confirming");
    else if (hash && isConfirming) setStatus("pending");
    else if (isSuccess) setStatus("processing");
  }, [hasSubmitted, writeError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (status === "processing") {
      const timer = setTimeout(() => setStatus("done"), 3000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  function write(tokenAddress: string) {
    writeContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20PermitAbi,
      functionName: "approve",
      args: [SUBSCRIPTION_MANAGER_ADDRESS, 0n],
    });
    setHasSubmitted(true);
  }

  return { write, status, error: writeError ?? receiptError ?? null };
}
