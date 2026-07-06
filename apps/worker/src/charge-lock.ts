import type { Redis } from "ioredis";

const LOCK_TTL_SECONDS = 600; // 10 minutes: long enough to cover submission + 1 confirmation, short enough to self-heal if the process crashes mid-job.

function lockKey(onchainSubId: string, periodEnd: Date): string {
  return `charging:${onchainSubId}:${periodEnd.toISOString()}`;
}

export async function acquireChargeLock(redis: Redis, onchainSubId: string, periodEnd: Date): Promise<boolean> {
  const result = await redis.set(lockKey(onchainSubId, periodEnd), "1", "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

export async function releaseChargeLock(redis: Redis, onchainSubId: string, periodEnd: Date): Promise<void> {
  await redis.del(lockKey(onchainSubId, periodEnd));
}
