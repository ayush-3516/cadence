import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";

export type Merchant = typeof schema.merchant.$inferSelect;

@Injectable()
export class MerchantsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async createForSession(ownerAddress: string, name: string): Promise<Merchant> {
    const existing = await this.findByOwnerAddress(ownerAddress, false);
    if (existing) {
      throw new AppException({
        type: "invalid_request_error",
        code: "merchant_already_exists",
        message: "A merchant account already exists for this address.",
        param: "ownerAddress",
      });
    }

    const [created] = await this.db
      .insert(schema.merchant)
      .values({ name, ownerAddress, livemode: false })
      .returning();
    return created;
  }

  async findByOwnerAddress(ownerAddress: string, livemode: boolean): Promise<Merchant | undefined> {
    const [found] = await this.db
      .select()
      .from(schema.merchant)
      .where(and(eq(schema.merchant.ownerAddress, ownerAddress), eq(schema.merchant.livemode, livemode)));
    return found;
  }

  async findByOwnerAddressById(merchantId: string): Promise<Merchant | undefined> {
    const [found] = await this.db.select().from(schema.merchant).where(eq(schema.merchant.id, merchantId));
    return found;
  }
}
