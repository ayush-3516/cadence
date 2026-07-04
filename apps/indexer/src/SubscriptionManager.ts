import { ponder } from "ponder:registry";
import { onchainPlan } from "ponder:schema";

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
