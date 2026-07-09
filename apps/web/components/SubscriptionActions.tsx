"use client";

import { useSubscriptionWrite } from "../lib/hooks/useSubscriptionWrite.js";

export interface SubscriptionActionsProps {
  subId: string;
  status: string;
}

const STATUS_MESSAGE: Record<string, string> = {
  confirming: "Confirm in your wallet…",
  pending: "Transaction submitted, waiting for confirmation…",
  processing: "Confirmed — updating…",
  error: "Something went wrong. Please try again.",
};

export function SubscriptionActions({ subId, status }: SubscriptionActionsProps) {
  const cancelWrite = useSubscriptionWrite("cancel");
  const pauseWrite = useSubscriptionWrite("pauseSubscription");
  const resumeWrite = useSubscriptionWrite("resumeSubscription");

  const anyInFlight = [cancelWrite.status, pauseWrite.status, resumeWrite.status].some((s) => s === "confirming" || s === "pending");
  const activeStatus = [cancelWrite.status, pauseWrite.status, resumeWrite.status].find((s) => s !== "idle" && s !== "done");

  return (
    <div className="flex flex-col gap-2 mt-4">
      <div className="flex gap-2">
        {status === "active" && (
          <button
            onClick={() => pauseWrite.write(subId)}
            disabled={anyInFlight}
            className="rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
          >
            Pause
          </button>
        )}
        {status === "paused" && (
          <button
            onClick={() => resumeWrite.write(subId)}
            disabled={anyInFlight}
            className="rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
          >
            Resume
          </button>
        )}
        <button
          onClick={() => cancelWrite.write(subId, [true])}
          disabled={anyInFlight}
          className="rounded-md border border-signal/50 text-signal px-3 py-1.5 text-sm font-body disabled:opacity-50"
        >
          Cancel immediately
        </button>
        <button
          onClick={() => cancelWrite.write(subId, [false])}
          disabled={anyInFlight}
          className="rounded-md border border-paper/30 px-3 py-1.5 text-sm font-body disabled:opacity-50"
        >
          Cancel at period end
        </button>
      </div>
      {activeStatus && STATUS_MESSAGE[activeStatus] && <p className="font-body text-xs text-slate">{STATUS_MESSAGE[activeStatus]}</p>}
    </div>
  );
}
