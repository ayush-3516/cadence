import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type DbClient = NodePgDatabase<typeof schema>;

export function createDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export { schema };
