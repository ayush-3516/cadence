import { ponder } from "ponder:registry";
import { onchainPlan, onchainSubscription } from "ponder:schema";

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
