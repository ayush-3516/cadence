"use client";

import { useEffect } from "react";
import { useCreatePlanSubmit, type CreatePlanStatus } from "../../lib/hooks/useCreatePlanSubmit.js";
import type { PlanDetailsFormValues } from "./PlanDetailsForm.js";

export interface PlanReviewSubmitProps {
  values: PlanDetailsFormValues;
  onDone: () => void;
}

const STATUS_MESSAGE: Record<Exclude<CreatePlanStatus, "idle" | "error" | "done">, string> = {
  "deploying-split": "Deploying split contract — confirm in your wallet…",
  "split-confirmed": "Split deployed.",
  "preparing-plan": "Preparing plan…",
  "confirming-plan": "Confirm in your wallet…",
  "pending-plan": "Waiting for confirmation…",
};

const IN_FLIGHT_STATUSES: CreatePlanStatus[] = ["deploying-split", "split-confirmed", "preparing-plan", "confirming-plan", "pending-plan"];

export function PlanReviewSubmit({ values, onDone }: PlanReviewSubmitProps) {
  const { status, error, submit } = useCreatePlanSubmit();

  useEffect(() => {
    if (status === "done") onDone();
  }, [status, onDone]);

  const inFlight = IN_FLIGHT_STATUSES.includes(status);

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div className="flex flex-col gap-2 font-body text-sm">
        <div>
          <span className="text-slate">Amount:</span> <span className="font-data">{values.amount} USDC</span>
        </div>
        <div>
          <span className="text-slate">Period:</span> <span className="font-data">{values.periodSeconds}s</span>
        </div>
        <div>
          <span className="text-slate">Trial:</span> <span className="font-data">{values.trialSeconds}s</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-slate">Recipients:</span>
          {values.recipients.map((r, i) => (
            <div key={i} className="font-data pl-3">
              {r.address} — {r.percentage}%
            </div>
          ))}
        </div>
      </div>

      {status !== "idle" && status !== "error" && status !== "done" && (
        <p className="font-body text-sm text-slate">{STATUS_MESSAGE[status]}</p>
      )}

      {status === "error" && error && (
        <p className="font-body text-sm text-signal">{error.message}</p>
      )}

      <button
        type="button"
        disabled={inFlight}
        onClick={() => submit(values)}
        className="self-start rounded-md bg-sapphire text-paper px-5 py-2.5 font-body font-semibold disabled:opacity-40"
      >
        {status === "error" ? "Retry" : "Create Plan"}
      </button>
    </div>
  );
}
