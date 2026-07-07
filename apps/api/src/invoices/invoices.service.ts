import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { schema, onchainSchema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";

export type InvoiceRow = typeof schema.invoice.$inferSelect;

@Injectable()
export class InvoicesService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async listForMerchant(
    merchantId: string,
    params: { subscriberAddress?: string; limit: number; startingAfter: string | null },
  ): Promise<InvoiceRow[]> {
    const conditions = [eq(schema.invoice.merchantId, merchantId)];

    if (params.subscriberAddress) {
      const subIds = await this.db
        .select({ onchainSubId: onchainSchema.onchainSubscription.onchainSubId })
        .from(onchainSchema.onchainSubscription)
        .where(eq(onchainSchema.onchainSubscription.subscriberAddress, params.subscriberAddress));
      const ids = subIds.map((r) => r.onchainSubId);
      if (ids.length === 0) return [];
      // inArray (not a raw sql `= ANY(${ids})`) — node-postgres does not serialize a plain JS
      // array bind parameter as a Postgres array literal in that position, which fails at
      // query time with "malformed array literal". inArray expands to `IN ($1, $2, ...)`,
      // which binds each id as its own scalar parameter and works correctly. Same approach as
      // WebhookDeliveriesService.ownedEndpointIds's inArray(endpointId, endpointIds) usage.
      conditions.push(inArray(schema.invoice.onchainSubId, ids));
    }

    // Same compound (createdAt, id) correlated-subquery cursor pattern as Phase 1g's
    // WebhookDeliveriesService.listForMerchant — invoice.id is a random gen_random_uuid()
    // UUID, so gt(id)+asc(id) alone is meaningless, and a naive JS-Date round-trip for the
    // cursor's createdAt silently truncates Postgres's microsecond precision to JS Date's
    // millisecond precision (see Phase 1g's progress.md for the full incident this pattern
    // is copied from). Compare entirely inside Postgres via a correlated subquery instead.
    if (params.startingAfter !== null) {
      const [existsRow] = await this.db
        .select({ id: schema.invoice.id })
        .from(schema.invoice)
        .where(and(eq(schema.invoice.id, params.startingAfter), eq(schema.invoice.merchantId, merchantId)));
      if (existsRow) {
        const cursorCreatedAt = this.db.select({ createdAt: schema.invoice.createdAt }).from(schema.invoice).where(eq(schema.invoice.id, params.startingAfter));
        conditions.push(
          or(
            sql`${schema.invoice.createdAt} > (${cursorCreatedAt})`,
            and(sql`${schema.invoice.createdAt} = (${cursorCreatedAt})`, gt(schema.invoice.id, params.startingAfter)),
          )!,
        );
      }
    }

    return this.db
      .select()
      .from(schema.invoice)
      .where(and(...conditions))
      .orderBy(asc(schema.invoice.createdAt), asc(schema.invoice.id))
      .limit(params.limit + 1);
  }

  async getById(merchantId: string, id: string): Promise<InvoiceRow | undefined> {
    const [row] = await this.db.select().from(schema.invoice).where(and(eq(schema.invoice.id, id), eq(schema.invoice.merchantId, merchantId)));
    return row;
  }
}
