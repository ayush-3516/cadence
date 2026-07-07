import { Queue, Worker, type Job } from "bullmq";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { and, eq } from "drizzle-orm";
import { schema, onchainSchema, type DbClient } from "@cadence/db";
import { feeRegistryAbi } from "@cadence/shared";
import type { WorkerConfig } from "./config.js";
import { findDueSubscriptions } from "./due-query.js";
import { reconcileDunningState } from "./dunning.js";
import { acquireChargeLock, releaseChargeLock } from "./charge-lock.js";
import { createNonceManager, type NonceManager } from "./nonce-manager.js";
import { submitCharge } from "./charge-submitter.js";
import { emitEvent } from "./events.js";
import { deliverWebhook } from "./webhook-delivery.js";
import { generateInvoice } from "./invoices.js";
import { renderInvoicePdf } from "./invoice-pdf.js";
import { createS3Client, uploadInvoicePdf as uploadInvoicePdfToClient } from "./invoice-storage.js";
import type { Redis } from "ioredis";

export const CHARGE_SCHEDULER_QUEUE_NAME = "charge-scheduler";
export const CHARGE_QUEUE_NAME = "charge-queue";
export const WEBHOOK_QUEUE_NAME = "webhook-queue";

export interface ChargeJobData {
  subId: string;
  periodEnd: string; // ISO string — BullMQ job data must be JSON-serializable, so Date is not usable directly
  chainId: number;
}

export interface WebhookJobData {
  deliveryId: string;
}

// BullMQ's Job.validateOptions rejects any custom jobId containing a ":"
// unless it splits into exactly 3 segments (a legacy compatibility rule for
// old repeatable-job ids) — see bullmq's job.js. An ISO timestamp contains
// two colons of its own (e.g. "2026-07-06T18:46:37.000Z"), so naively joining
// `${subId}:${periodEnd.toISOString()}` produces 4 segments and throws at
// enqueue time for every due subscription. Colons are stripped entirely here
// so the id is always colon-free (0 segments when split), which is always
// accepted, while remaining unique per (subId, periodEnd) pair.
export function chargeJobId(onchainSubId: string, periodEnd: Date): string {
  return `${onchainSubId}-${periodEnd.toISOString().replace(/[:.]/g, "")}`;
}

export function createQueues(config: WorkerConfig, db: DbClient, redis: Redis) {
  const connection = { connection: redis };

  const chargeSchedulerQueue = new Queue(CHARGE_SCHEDULER_QUEUE_NAME, connection);
  const chargeQueue = new Queue<ChargeJobData>(CHARGE_QUEUE_NAME, connection);
  const webhookQueue = new Queue<WebhookJobData>(WEBHOOK_QUEUE_NAME, connection);

  const account = privateKeyToAccount(config.relayerPrivateKey);
  const publicClient = createPublicClient({ transport: http(config.rpcUrlHttp) });
  const walletClient = createWalletClient({ account, transport: http(config.rpcUrlHttp) });
  const s3Client = createS3Client({
    endpoint: config.s3Endpoint,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
  });

  let nonceManagerPromise: Promise<NonceManager> | null = null;
  function getNonceManager(): Promise<NonceManager> {
    if (!nonceManagerPromise) {
      nonceManagerPromise = createNonceManager(publicClient, account.address);
    }
    return nonceManagerPromise;
  }

  async function scheduleDueCharges(): Promise<void> {
    await reconcileDunningState(db, config.chainId, async (deliveryId) => {
      await webhookQueue.add("deliver", { deliveryId }, { jobId: deliveryId });
    });
    const due = await findDueSubscriptions(db, { chainId: config.chainId, batchSize: 100 });
    for (const sub of due) {
      await chargeQueue.add(
        "charge",
        { subId: sub.onchainSubId, periodEnd: sub.currentPeriodEnd.toISOString(), chainId: config.chainId },
        { jobId: chargeJobId(sub.onchainSubId, sub.currentPeriodEnd) },
      );
    }
  }

  async function processChargeJob(job: Job<ChargeJobData>): Promise<void> {
    const periodEnd = new Date(job.data.periodEnd);
    const acquired = await acquireChargeLock(redis, job.data.subId, periodEnd);
    if (!acquired) {
      return; // Another tick or process already owns this sub+period — not a failure.
    }

    try {
      const nonceManager = await getNonceManager();
      const { txHash } = await submitCharge(
        { walletClient, publicClient, subscriptionManagerAddress: config.subscriptionManagerAddress, nonceManager },
        job.data.subId,
      );
      console.log(`Charged subId=${job.data.subId} txHash=${txHash}`);

      const [sub] = await db.select().from(onchainSchema.onchainSubscription).where(eq(onchainSchema.onchainSubscription.onchainSubId, job.data.subId));
      if (sub) {
        const [plan] = await db.select().from(onchainSchema.onchainPlan).where(eq(onchainSchema.onchainPlan.onchainPlanId, sub.onchainPlanId));
        if (plan) {
          const [merchant] = await db.select().from(schema.merchant).where(and(eq(schema.merchant.ownerAddress, plan.merchantAddress), eq(schema.merchant.livemode, false)));
          if (merchant) {
            await emitEvent(
              db,
              { merchantId: merchant.id, type: "subscription.renewed", data: { onchain_sub_id: job.data.subId, tx_hash: txHash }, onchainTxHash: txHash },
              async (deliveryId) => {
                await webhookQueue.add("deliver", { deliveryId }, { jobId: deliveryId });
              },
            );

            // Invoice generation is a best-effort side effect, deliberately isolated from the
            // charge/webhook outcome above: the on-chain charge already succeeded regardless of
            // whether a PDF could be produced. A failure here must not throw out of
            // processChargeJob (which would trigger a BullMQ retry of the WHOLE job, including a
            // second submitCharge call) and must not block subscription.renewed, which has
            // already fired above.
            try {
              const feeBps = await publicClient.readContract({
                address: config.feeRegistryAddress,
                abi: feeRegistryAbi,
                functionName: "getFeeBps",
                args: [merchant.ownerAddress as `0x${string}`],
              });
              await generateInvoice(
                {
                  db,
                  renderInvoicePdf,
                  uploadInvoicePdf: (bucket, key, body) => uploadInvoicePdfToClient(s3Client, bucket, key, body),
                  s3Bucket: config.s3Bucket,
                  s3PublicBaseUrl: config.s3PublicBaseUrl,
                },
                {
                  merchantId: merchant.id,
                  merchantName: merchant.name,
                  subscriberAddress: sub.subscriberAddress,
                  onchainSubId: job.data.subId,
                  onchainPlanId: sub.onchainPlanId,
                  amount: BigInt(plan.amount),
                  feeBps: BigInt(feeBps),
                  token: "USDC",
                  periodEnd,
                  txHash,
                  chainId: config.chainId,
                },
              );
              await emitEvent(
                db,
                { merchantId: merchant.id, type: "invoice.created", data: { onchain_sub_id: job.data.subId, tx_hash: txHash }, onchainTxHash: txHash },
                async (deliveryId) => {
                  await webhookQueue.add("deliver", { deliveryId }, { jobId: deliveryId });
                },
              );
            } catch (err) {
              console.error(`Invoice generation failed for subId=${job.data.subId} txHash=${txHash}:`, err);
            }
          }
        }
      }
    } finally {
      await releaseChargeLock(redis, job.data.subId, periodEnd);
    }
  }

  function startChargeWorker(): Worker<ChargeJobData> {
    return new Worker<ChargeJobData>(CHARGE_QUEUE_NAME, processChargeJob, {
      ...connection,
      concurrency: 1, // REQUIRED for nonce-manager correctness — see nonce-manager.ts.
      settings: { backoffStrategy: () => 5_000 },
    });
  }

  async function processWebhookJob(job: Job<WebhookJobData>): Promise<void> {
    await deliverWebhook(db, job.data.deliveryId, config.webhookSigningRotationKey);
  }

  function startWebhookWorker(): Worker<WebhookJobData> {
    return new Worker<WebhookJobData>(WEBHOOK_QUEUE_NAME, processWebhookJob, connection);
  }

  return { chargeSchedulerQueue, chargeQueue, webhookQueue, scheduleDueCharges, startChargeWorker, startWebhookWorker };
}
