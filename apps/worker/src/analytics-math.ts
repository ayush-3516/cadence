const SECONDS_PER_30_DAYS = 30 * 86400;

export function monthlyNormalizedAmount(amountRaw: string, periodSeconds: bigint): number {
  const amountUsd = Number(amountRaw) / 1e6;
  return amountUsd * (SECONDS_PER_30_DAYS / Number(periodSeconds));
}

export interface SubscriptionForMrr {
  status: string;
  amountRaw: string;
  periodSeconds: bigint;
}

export interface MrrArrArpuResult {
  mrrUsd: number;
  arrUsd: number;
  arpuUsd: number;
  activeSubs: number;
  trialingSubs: number;
}

export function computeMrrArrArpu(subscriptions: SubscriptionForMrr[]): MrrArrArpuResult {
  let mrrUsd = 0;
  let activeSubs = 0;
  let trialingSubs = 0;

  for (const sub of subscriptions) {
    if (sub.status === "active") {
      mrrUsd += monthlyNormalizedAmount(sub.amountRaw, sub.periodSeconds);
      activeSubs += 1;
    } else if (sub.status === "trialing") {
      trialingSubs += 1;
    }
  }

  const arrUsd = mrrUsd * 12;
  const arpuUsd = activeSubs > 0 ? mrrUsd / activeSubs : 0;

  return { mrrUsd, arrUsd, arpuUsd, activeSubs, trialingSubs };
}

export interface ChurnResult {
  churnRate: number;
  revenueChurn: number;
}

export function computeChurn(
  windowStart: { activeSubs: number; mrrUsd: number },
  canceledInWindow: number,
  windowEnd: { mrrUsd: number },
): ChurnResult {
  const churnRate = windowStart.activeSubs > 0 ? canceledInWindow / windowStart.activeSubs : 0;
  const mrrLost = Math.max(0, windowStart.mrrUsd - windowEnd.mrrUsd);
  const revenueChurn = windowStart.mrrUsd > 0 ? mrrLost / windowStart.mrrUsd : 0;
  return { churnRate, revenueChurn };
}
