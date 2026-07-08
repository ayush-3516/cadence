import Redis from "ioredis";
import { Queue, Worker } from "bullmq";
import { createDbClient } from "@cadence/db";
import { loadConfig } from "./config.js";
import { createQueues, CHARGE_SCHEDULER_QUEUE_NAME } from "./queues.js";
import { runAnalyticsRollup } from "./analytics-rollup.js";

async function main() {
  const config = loadConfig();
  const db = createDbClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  const { chargeSchedulerQueue, scheduleDueCharges, startChargeWorker, startWebhookWorker } = createQueues(config, db, redis);

  await chargeSchedulerQueue.upsertJobScheduler(
    `${CHARGE_SCHEDULER_QUEUE_NAME}-repeat`,
    { every: config.schedulerIntervalMs },
    { name: "scan-due-subscriptions", data: {} },
  );

  const schedulerQueueWorker = new Worker(
    CHARGE_SCHEDULER_QUEUE_NAME,
    async () => {
      await scheduleDueCharges();
    },
    { connection: redis },
  );

  const chargeWorker = startChargeWorker();
  const webhookWorker = startWebhookWorker();

  const analyticsRollupQueue = new Queue("analytics-rollup", { connection: redis });
  await analyticsRollupQueue.upsertJobScheduler(
    "analytics-rollup-repeat",
    { every: 24 * 60 * 60 * 1000 }, // once per day
    { name: "run-analytics-rollup", data: {} },
  );
  const analyticsRollupWorker = new Worker(
    "analytics-rollup",
    async () => {
      await runAnalyticsRollup(db, new Date());
    },
    { connection: redis },
  );

  console.log(`Worker started. Scheduler interval: ${config.schedulerIntervalMs}ms.`);

  async function shutdown() {
    console.log("Shutting down...");
    await schedulerQueueWorker.close();
    await chargeWorker.close();
    await webhookWorker.close();
    await analyticsRollupWorker.close();
    await redis.quit();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
