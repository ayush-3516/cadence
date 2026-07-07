import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface WorkerConfig {
  databaseUrl: string;
  redisUrl: string;
  relayerPrivateKey: `0x${string}`;
  rpcUrlHttp: string;
  chainId: number;
  schedulerIntervalMs: number;
  subscriptionManagerAddress: `0x${string}`;
  webhookSigningRotationKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): WorkerConfig {
  const chainId = Number(requireEnv("CHAIN_ID"));
  const relayerPrivateKey = requireEnv("RELAYER_PRIVATE_KEY");
  if (!relayerPrivateKey.startsWith("0x")) {
    throw new Error("RELAYER_PRIVATE_KEY must start with 0x");
  }

  const deploymentPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../deployments",
    `${chainId}.json`,
  );
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8")) as { subscriptionManager: string };

  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    relayerPrivateKey: relayerPrivateKey as `0x${string}`,
    rpcUrlHttp: requireEnv("RPC_URL_HTTP"),
    chainId,
    schedulerIntervalMs: process.env.CHARGE_SCHEDULER_INTERVAL_MS
      ? Number(process.env.CHARGE_SCHEDULER_INTERVAL_MS)
      : 300_000,
    subscriptionManagerAddress: deployment.subscriptionManager as `0x${string}`,
    webhookSigningRotationKey: requireEnv("WEBHOOK_SIGNING_ROTATION_KEY"),
  };
}
