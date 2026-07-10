"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { usePortalPlan } from "../../../../../lib/hooks/usePortalPlan.js";
import { useSubscribeSubmit, type SubscribeStatus } from "../../../../../lib/hooks/useSubscribeSubmit.js";

const STATUS_MESSAGE: Record<Exclude<SubscribeStatus, "idle" | "error" | "done">, string> = {
  preparing: "Preparing…",
  signing: "Sign in your wallet…",
  submitting: "Confirm in your wallet…",
  confirming: "Waiting for confirmation…",
};

const IN_FLIGHT_STATUSES: SubscribeStatus[] = ["preparing", "signing", "submitting", "confirming"];

export default function SubscribePage() {
  const { planId } = useParams<{ planId: string }>();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { data: plan, isLoading, error: planError } = usePortalPlan(planId);
  const { status, error, submit } = useSubscribeSubmit();
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    if (status === "done") router.push("/portal");
  }, [status, router]);

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (planError || !plan) return <p className="font-body text-signal">Could not load this plan.</p>;

  const inFlight = IN_FLIGHT_STATUSES.includes(status);

  function handleSubscribeClick() {
    if (!isConnected || !address) {
      setShowConnect(true);
      return;
    }
    submit(planId, address);
  }

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <h1 className="font-display text-2xl">{plan.name ?? "Subscribe"}</h1>
      <div className="font-data tabular-nums text-sm">
        {plan.amount} {plan.token} / {plan.period_seconds}s
      </div>

      {showConnect && !isConnected && <ConnectKitButton />}

      {status !== "idle" && status !== "error" && status !== "done" && (
        <p className="font-body text-sm text-slate">{STATUS_MESSAGE[status]}</p>
      )}

      {status === "error" && error && <p className="font-body text-sm text-signal">{error.message}</p>}

      <button
        type="button"
        disabled={inFlight}
        onClick={handleSubscribeClick}
        className="self-start rounded-md bg-sapphire text-paper px-5 py-2.5 font-body font-semibold disabled:opacity-40"
      >
        {status === "error" ? "Retry" : "Subscribe"}
      </button>
    </div>
  );
}
