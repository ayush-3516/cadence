import { spawn, type ChildProcess } from "node:child_process";

export interface StartedAnvil {
  rpcUrl: string;
  stop(): Promise<void>;
}

export async function startAnvil(port: number): Promise<StartedAnvil> {
  const child: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "84532", "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const rpcUrl = `http://127.0.0.1:${port}`;

  await waitForRpc(rpcUrl);

  return {
    rpcUrl,
    async stop() {
      child.kill();
    },
  };
}

async function waitForRpc(rpcUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
      });
      if (response.ok) return;
    } catch {
      // anvil not accepting connections yet — retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`anvil did not become ready on ${rpcUrl} within ${timeoutMs}ms`);
}
