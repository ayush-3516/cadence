import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis";
import Redis from "ioredis";
import { acquireChargeLock, releaseChargeLock } from "../src/charge-lock.js";

describe("charge lock", () => {
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7").start();
    redis = new Redis(container.getConnectionUrl());
  }, 60_000);

  afterEach(async () => {
    await redis.flushall();
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  const periodEnd = new Date("2026-08-01T00:00:00Z");

  it("acquires a lock that does not yet exist", async () => {
    const acquired = await acquireChargeLock(redis, "42", periodEnd);
    expect(acquired).toBe(true);
  });

  it("fails to acquire a lock already held for the same sub+period", async () => {
    await acquireChargeLock(redis, "42", periodEnd);
    const secondAttempt = await acquireChargeLock(redis, "42", periodEnd);
    expect(secondAttempt).toBe(false);
  });

  it("allows a different period for the same sub to acquire independently", async () => {
    await acquireChargeLock(redis, "42", periodEnd);
    const otherPeriod = await acquireChargeLock(redis, "42", new Date("2026-09-01T00:00:00Z"));
    expect(otherPeriod).toBe(true);
  });

  it("allows re-acquiring after release", async () => {
    await acquireChargeLock(redis, "42", periodEnd);
    await releaseChargeLock(redis, "42", periodEnd);
    const reacquired = await acquireChargeLock(redis, "42", periodEnd);
    expect(reacquired).toBe(true);
  });
});
