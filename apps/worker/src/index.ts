import Redis from "ioredis";
import { Worker } from "bullmq";
import { createDbClient } from "@cadence/db";
import { loadConfig } from "./config.js";
import { createQueues, CHARGE_SCHEDULER_QUEUE_NAME } from "./queues.js";

async function main() {
  const config = loadConfig();
  const db = createDbClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  const { chargeSchedulerQueue, scheduleDueCharges, startChargeWorker } = createQueues(config, db, redis);

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

  console.log(`Worker started. Scheduler interval: ${config.schedulerIntervalMs}ms.`);

  async function shutdown() {
    console.log("Shutting down...");
    await schedulerQueueWorker.close();
    await chargeWorker.close();
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
