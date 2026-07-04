import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DB_CLIENT } from "../db/db.module.js";
import type { DbClient } from "@cadence/db";

@Controller("v1/health")
export class HealthController {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  @Get()
  async check() {
    await this.db.execute(sql`SELECT 1`);
    return { status: "ok" };
  }
}
