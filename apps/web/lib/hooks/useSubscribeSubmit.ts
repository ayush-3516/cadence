import { useEffect, useState } from "react";
import { useSignTypedData, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { encodeFunctionData, parseSignature } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared/abis";
import { apiFetch } from "../apiFetch.js";

export type SubscribeStatus = "idle" | "preparing" | "signing" | "submitting" | "confirming" | "done" | "error";

export interface UseSubscribeSubmitResult {
  status: SubscribeStatus;
  error: Error | null;
  submit: (planId: string, owner: string) => void;
}

interface PreparedSubscribe {
  permit: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: { Permit: { name: string; type: string }[] };
    message: { owner: string; spender: string; value: string; nonce: string; deadline: string };
  };
  subscribe: { to: string; fn: "subscribeWithPermit"; planId: string; deadline: string };
}

export function useSubscribeSubmit(): UseSubscribeSubmitResult {
  const [status, setStatus] = useState<SubscribeStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [hasSubmittedTx, setHasSubmittedTx] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();
  const { sendTransaction, data: hash, error: sendError, isPending } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!hasSubmittedTx) return;
    if (sendError) setStatus("error");
    else if (isPending) setStatus("submitting");
    else if (hash && isConfirming) setStatus("confirming");
    else if (hash && isSuccess) setStatus("done");
  }, [hasSubmittedTx, sendError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (sendError) setError(sendError);
    if (receiptError) setError(receiptError);
  }, [sendError, receiptError]);

  async function submit(planId: string, owner: string) {
    setError(null);
    try {
      setStatus("preparing");
      const query = new URLSearchParams({ planId, owner });
      const prepared = (await apiFetch(`/v1/prepare/subscribe?${query.toString()}`)) as PreparedSubscribe;

      setStatus("signing");
      const signature = await signTypedDataAsync({
        domain: { ...prepared.permit.domain, verifyingContract: prepared.permit.domain.verifyingContract as `0x${string}` },
        types: prepared.permit.types,
        primaryType: "Permit",
        message: prepared.permit.message,
      });

      // parseSignature's return type allows `v` to be undefined (its `yParityOrV
      // === 0 | 1` branch); `yParity` is always present, and the wallet-standard
      // 27/28 convention this endpoint's permit signing always produces means
      // `yParity + 27` is the correct, type-safe way to derive `v` regardless of
      // which branch parseSignature took, without depending on its possibly-
      // undefined `v` field directly.
      const { r, s, yParity } = parseSignature(signature);
      const v = yParity + 27;

      const data = encodeFunctionData({
        abi: subscriptionManagerAbi,
        functionName: "subscribeWithPermit",
        args: [BigInt(prepared.subscribe.planId), BigInt(prepared.permit.message.value), BigInt(prepared.subscribe.deadline), v, r, s],
      });

      sendTransaction({ to: prepared.subscribe.to as `0x${string}`, data });
      setHasSubmittedTx(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus("error");
    }
  }

  return { status, error, submit };
}
