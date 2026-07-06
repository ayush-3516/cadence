import { Queue, Worker, type Job } from "bullmq";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DbClient } from "@cadence/db";
import type { WorkerConfig } from "./config.js";
import { findDueSubscriptions } from "./due-query.js";
import { acquireChargeLock, releaseChargeLock } from "./charge-lock.js";
import { createNonceManager, type NonceManager } from "./nonce-manager.js";
import { submitCharge } from "./charge-submitter.js";
import type { Redis } from "ioredis";

export const CHARGE_SCHEDULER_QUEUE_NAME = "charge-scheduler";
export const CHARGE_QUEUE_NAME = "charge-queue";

export interface ChargeJobData {
  subId: string;
  periodEnd: string; // ISO string — BullMQ job data must be JSON-serializable, so Date is not usable directly
  chainId: number;
}

export function createQueues(config: WorkerConfig, db: DbClient, redis: Redis) {
  const connection = { connection: redis };

  const chargeSchedulerQueue = new Queue(CHARGE_SCHEDULER_QUEUE_NAME, connection);
  const chargeQueue = new Queue<ChargeJobData>(CHARGE_QUEUE_NAME, connection);

  const account = privateKeyToAccount(config.relayerPrivateKey);
  const publicClient = createPublicClient({ transport: http(config.rpcUrlHttp) });
  const walletClient = createWalletClient({ account, transport: http(config.rpcUrlHttp) });

  let nonceManagerPromise: Promise<NonceManager> | null = null;
  function getNonceManager(): Promise<NonceManager> {
    if (!nonceManagerPromise) {
      nonceManagerPromise = createNonceManager(publicClient, account.address);
    }
    return nonceManagerPromise;
  }

  async function scheduleDueCharges(): Promise<void> {
    const due = await findDueSubscriptions(db, { chainId: config.chainId, batchSize: 100 });
    for (const sub of due) {
      await chargeQueue.add(
        "charge",
        { subId: sub.onchainSubId, periodEnd: sub.currentPeriodEnd.toISOString(), chainId: config.chainId },
        { jobId: `${sub.onchainSubId}:${sub.currentPeriodEnd.toISOString()}` },
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

  return { chargeSchedulerQueue, chargeQueue, scheduleDueCharges, startChargeWorker };
}
