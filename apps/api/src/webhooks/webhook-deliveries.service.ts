import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";

export type WebhookDeliveryRow = typeof schema.webhookDelivery.$inferSelect;

@Injectable()
export class WebhookDeliveriesService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private async ownedEndpointIds(merchantId: string): Promise<string[]> {
    const rows = await this.db.select({ id: schema.webhookEndpoint.id }).from(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.merchantId, merchantId));
    return rows.map((r) => r.id);
  }

  async listForMerchant(
    merchantId: string,
    params: { status?: string; limit: number; startingAfter: string | null },
  ): Promise<WebhookDeliveryRow[]> {
    const endpointIds = await this.ownedEndpointIds(merchantId);
    if (endpointIds.length === 0) return [];

    const conditions = [inArray(schema.webhookDelivery.endpointId, endpointIds)];
    if (params.status) conditions.push(eq(schema.webhookDelivery.status, params.status as "pending" | "succeeded" | "failed" | "dead"));

    // `webhookDelivery.id` is a random gen_random_uuid() UUID, not a sortable value — gt(id)+asc(id)
    // alone would be semantically meaningless (see Task 5's WebhookEndpointsService, where this
    // exact mistake was made and fixed). Page by (createdAt, id) instead: createdAt gives real
    // chronological order, id is only a tiebreaker for two rows sharing a timestamp.
    //
    // Do NOT round-trip the cursor row's createdAt through a JS Date and rebind it as a query
    // parameter — `timestamp(..., { withTimezone: true })` has no explicit Drizzle `mode`, so it
    // defaults to mapping Postgres `timestamptz` (microsecond precision) to a JS `Date` (millisecond
    // precision). Reading the value out and back in as a bind parameter silently truncates it
    // downward, which makes the cursor row satisfy `createdAt > <truncated cursor>` against its own
    // real value and reappear on the next page (this exact bug was found and fixed via a correlated
    // subquery in Task 5's post-review fix commit — reproduce that approach here from the start
    // rather than the naive JS-Date-roundtrip version).
    if (params.startingAfter !== null) {
      const [existsRow] = await this.db
        .select({ id: schema.webhookDelivery.id })
        .from(schema.webhookDelivery)
        .where(and(eq(schema.webhookDelivery.id, params.startingAfter), inArray(schema.webhookDelivery.endpointId, endpointIds)));
      if (existsRow) {
        const cursorCreatedAt = this.db
          .select({ createdAt: schema.webhookDelivery.createdAt })
          .from(schema.webhookDelivery)
          .where(eq(schema.webhookDelivery.id, params.startingAfter));
        conditions.push(
          or(
            sql`${schema.webhookDelivery.createdAt} > (${cursorCreatedAt})`,
            and(sql`${schema.webhookDelivery.createdAt} = (${cursorCreatedAt})`, gt(schema.webhookDelivery.id, params.startingAfter)),
          )!,
        );
      }
    }

    return this.db
      .select()
      .from(schema.webhookDelivery)
      .where(and(...conditions))
      .orderBy(asc(schema.webhookDelivery.createdAt), asc(schema.webhookDelivery.id))
      .limit(params.limit + 1);
  }

  async replay(merchantId: string, deliveryId: string): Promise<{ replayed: boolean }> {
    const endpointIds = await this.ownedEndpointIds(merchantId);
    // Guard against binding an empty-string UUID literal below when the caller's merchant has
    // no endpoints at all (Postgres rejects "" as invalid input for a uuid column, which would
    // otherwise surface as a 500 instead of the intended 404).
    const delivery =
      endpointIds.length > 0
        ? (
            await this.db
              .select()
              .from(schema.webhookDelivery)
              .where(and(eq(schema.webhookDelivery.id, deliveryId), inArray(schema.webhookDelivery.endpointId, endpointIds)))
          )[0]
        : undefined;

    if (!delivery) {
      throw new AppException({ type: "invalid_request_error", code: "webhook_delivery_not_found", message: "No webhook delivery with that id exists for this merchant.", param: "id", status: 404 });
    }

    await this.db.update(schema.webhookDelivery).set({ status: "pending", updatedAt: new Date() }).where(eq(schema.webhookDelivery.id, deliveryId));
    return { replayed: true };
  }
}
