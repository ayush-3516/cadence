import { useEffect, useState } from "react";
import { usePublicClient, useWalletClient, useSendTransaction, useWaitForTransactionReceipt } from "wagmi";
import { SplitV2Client } from "@0xsplits/splits-sdk";
import { SplitV2Type } from "@0xsplits/splits-sdk/types";
import { apiFetch } from "../apiFetch.js";
import type { PlanDetailsFormValues } from "../../components/plans/PlanDetailsForm.js";

export type CreatePlanStatus =
  | "idle"
  | "deploying-split"
  | "split-confirmed"
  | "preparing-plan"
  | "confirming-plan"
  | "pending-plan"
  | "done"
  | "error";

export interface UseCreatePlanSubmitResult {
  status: CreatePlanStatus;
  error: Error | null;
  submit: (values: PlanDetailsFormValues) => void;
}

const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

function toWeiAmount(amount: string): string {
  // USDC has 6 decimals — matches this codebase's existing test fixtures
  // (e.g. apps/api/test/setup.ts's amount: "20000000" for $20.00).
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = (fraction + "000000").slice(0, 6);
  return `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
}

export function useCreatePlanSubmit(): UseCreatePlanSubmitResult {
  const [status, setStatus] = useState<CreatePlanStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [hasSubmittedTx, setHasSubmittedTx] = useState(false);
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { data: walletClient } = useWalletClient();
  const { sendTransaction, data: hash, error: sendError, isPending } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!hasSubmittedTx) return;
    if (sendError) setStatus("error");
    else if (isPending) setStatus("confirming-plan");
    else if (hash && isConfirming) setStatus("pending-plan");
    else if (hash && isSuccess) setStatus("done");
  }, [hasSubmittedTx, sendError, isPending, hash, isConfirming, isSuccess]);

  useEffect(() => {
    if (receiptError) setStatus("error");
  }, [receiptError]);

  useEffect(() => {
    if (sendError) setError(sendError);
    if (receiptError) setError(receiptError);
  }, [sendError, receiptError]);

  async function submit(values: PlanDetailsFormValues) {
    setError(null);
    try {
      let payoutSplit: string;

      if (values.recipients.length === 1) {
        payoutSplit = values.recipients[0].address;
      } else {
        setStatus("deploying-split");
        const splitsClient = new SplitV2Client({ chainId: CHAIN_ID, publicClient, walletClient: walletClient ?? undefined });
        const { splitAddress } = await splitsClient.createSplit({
          recipients: values.recipients.map((r) => ({ address: r.address, percentAllocation: Number(r.percentage) })),
          distributorFeePercent: 0,
          splitType: SplitV2Type.Pull,
          chainId: CHAIN_ID,
        });
        payoutSplit = splitAddress;
        setStatus("split-confirmed");
      }

      setStatus("preparing-plan");
      const query = new URLSearchParams({
        payoutSplit,
        token: USDC_ADDRESS,
        amount: toWeiAmount(values.amount),
        period: String(values.periodSeconds),
        trial: String(values.trialSeconds),
      });
      const prepared = (await apiFetch(`/v1/prepare/plan?${query.toString()}`)) as { to: string; data: string; value: string };

      sendTransaction({
        to: prepared.to as `0x${string}`,
        data: prepared.data as `0x${string}`,
        value: BigInt(prepared.value),
      });
      setHasSubmittedTx(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStatus("error");
    }
  }

  return { status, error, submit };
}
