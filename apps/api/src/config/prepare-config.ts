import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface PrepareConfig {
  chainId: number;
  rpcUrlHttp: string;
  subscriptionManagerAddress: `0x${string}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadPrepareConfig(): PrepareConfig {
  const chainId = Number(requireEnv("CHAIN_ID"));
  const rpcUrlHttp = requireEnv("RPC_URL_HTTP");

  const deploymentPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../deployments",
    `${chainId}.json`,
  );
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8")) as { subscriptionManager: string };

  return {
    chainId,
    rpcUrlHttp,
    subscriptionManagerAddress: deployment.subscriptionManager as `0x${string}`,
  };
}
