import { ponder } from "ponder:registry";
import { onchainPlan, onchainSubscription, onchainCharge } from "ponder:schema";

ponder.on("SubscriptionManager:PlanCreated", async ({ event, context }) => {
  await context.db.insert(onchainPlan).values({
    onchainPlanId: event.args.planId.toString(),
    merchantAddress: event.args.merchant,
    payoutSplit: event.args.payoutSplit,
    token: event.args.token,
    amount: event.args.amount.toString(),
    periodSeconds: BigInt(event.args.period),
    trialSeconds: BigInt(event.args.trialPeriod),
    active: true,
    chainId: context.chain.id,
    createdBlock: event.block.number,
    createdTx: event.transaction.hash,
    createdAt: new Date(Number(event.block.timestamp) * 1000),
  });
});

ponder.on("SubscriptionManager:PlanStatusChanged", async ({ event, context }) => {
  await context.db
    .update(onchainPlan, { onchainPlanId: event.args.planId.toString() })
    .set({ active: event.args.active });
});

ponder.on("SubscriptionManager:Subscribed", async ({ event, context }) => {
  await context.db.insert(onchainSubscription).values({
    onchainSubId: event.args.subId.toString(),
    onchainPlanId: event.args.planId.toString(),
    subscriberAddress: event.args.subscriber,
    status: event.args.trialing ? "trialing" : "active",
    currentPeriodEnd: new Date(Number(event.args.currentPeriodEnd) * 1000),
    pausedRemaining: 0n,
    pendingCancel: false,
    chainId: context.chain.id,
    createdAt: new Date(Number(event.block.timestamp) * 1000),
    updatedAt: new Date(Number(event.block.timestamp) * 1000),
  });
});

ponder.on("SubscriptionManager:StatusChanged", async ({ event, context }) => {
  const statusMap = ["none", "trialing", "active", "past_due", "paused", "canceled"] as const;
  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      status: statusMap[event.args.status],
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});

ponder.on("SubscriptionManager:Paused(uint256 indexed subId, uint40 remaining)", async ({ event, context }) => {
  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      status: "paused",
      pausedRemaining: BigInt(event.args.remaining),
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});

ponder.on("SubscriptionManager:Resumed", async ({ event, context }) => {
  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      status: "active",
      pausedRemaining: 0n,
      currentPeriodEnd: new Date(Number(event.args.newPeriodEnd) * 1000),
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});

ponder.on("SubscriptionManager:CancelScheduled", async ({ event, context }) => {
  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      pendingCancel: true,
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});

ponder.on("SubscriptionManager:Canceled", async ({ event, context }) => {
  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      status: "canceled",
      canceledAt: new Date(Number(event.block.timestamp) * 1000),
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});

ponder.on("SubscriptionManager:Charged", async ({ event, context }) => {
  const usdValue = Number(event.args.amount) / 1e6; // USDC, 6 decimals

  await context.db.insert(onchainCharge).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    onchainSubId: event.args.subId.toString(),
    onchainPlanId: event.args.planId.toString(),
    status: "success",
    amount: event.args.amount.toString(),
    platformFee: event.args.platformFee.toString(),
    net: event.args.net.toString(),
    token: "USDC",
    usdValue: usdValue.toFixed(6),
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    chainId: context.chain.id,
    chargedAt: new Date(Number(event.block.timestamp) * 1000),
  });

  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      status: "active",
      currentPeriodEnd: new Date(Number(event.args.newPeriodEnd) * 1000),
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});

ponder.on("SubscriptionManager:ChargeFailed", async ({ event, context }) => {
  // ChargeFailed only carries (subId, reason) — no planId — but onchain_charge's
  // schema (Task 3, matching PRD §7.2) has onchain_plan_id NUMERIC NOT NULL. Look
  // it up from the already-indexed subscription row. The non-null assertion is
  // safe: Subscribed always fires (and is indexed) before any ChargeFailed for
  // the same subId can occur — a subscription must exist before it can fail a
  // charge.
  const sub = await context.db.find(onchainSubscription, {
    onchainSubId: event.args.subId.toString(),
  });

  await context.db.insert(onchainCharge).values({
    id: `${event.transaction.hash}:${event.log.logIndex}`,
    onchainSubId: event.args.subId.toString(),
    onchainPlanId: sub!.onchainPlanId,
    status: "failed",
    reason: event.args.reason,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    chainId: context.chain.id,
    chargedAt: new Date(Number(event.block.timestamp) * 1000),
  });

  await context.db
    .update(onchainSubscription, { onchainSubId: event.args.subId.toString() })
    .set({
      status: "past_due",
      updatedAt: new Date(Number(event.block.timestamp) * 1000),
    });
});
