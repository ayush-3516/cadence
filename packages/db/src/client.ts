import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as appSchema from "./schema.js";
import * as onchainSchema from "./onchain-schema.js";

const schema = { ...appSchema, ...onchainSchema };

export type DbClient = NodePgDatabase<typeof schema>;

export function createDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export { appSchema as schema, onchainSchema };
