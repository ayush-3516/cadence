import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";

let container: StartedPostgreSqlContainer;

export async function startTestDatabase(): Promise<string> {
  container = await new PostgreSqlContainer("postgres:16")
    .withDatabase("cadence_test")
    .withUsername("cadence")
    .withPassword("cadence")
    .start();

  const connectionUri = container.getConnectionUri();

  execSync("npx drizzle-kit migrate", {
    cwd: path.resolve(__dirname, "../../../packages/db"),
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "inherit",
  });

  return connectionUri;
}

export async function stopTestDatabase(): Promise<void> {
  await container.stop();
}
