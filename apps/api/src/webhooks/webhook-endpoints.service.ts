import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import { encryptSecret } from "@cadence/shared";
import { DB_CLIENT } from "../db/db.module.js";
import { AppException } from "../common/errors.js";
import type { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from "./webhook-endpoints.dto.js";

export type WebhookEndpointRow = typeof schema.webhookEndpoint.$inferSelect;

function generateRawSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

@Injectable()
export class WebhookEndpointsService {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient, private readonly webhookSigningRotationKey: string) {}

  async create(merchantId: string, body: CreateWebhookEndpointDto): Promise<WebhookEndpointRow & { signingSecret: string }> {
    const rawSecret = generateRawSigningSecret();
    const encrypted = encryptSecret(rawSecret, this.webhookSigningRotationKey);

    const [created] = await this.db
      .insert(schema.webhookEndpoint)
      .values({
        merchantId,
        url: body.url,
        signingSecret: encrypted,
        enabledEvents: body.enabledEvents ?? ["*"],
        livemode: false,
      })
      .returning();

    return { ...created, signingSecret: rawSecret };
  }

  async listForMerchant(
    merchantId: string,
    params: { limit: number; startingAfter: string | null },
  ): Promise<Omit<WebhookEndpointRow, "signingSecret">[]> {
    const conditions = [eq(schema.webhookEndpoint.merchantId, merchantId)];

    if (params.startingAfter !== null) {
      // `id` is a random UUIDv4 (see schema.ts), so it has no relationship to insertion
      // order and cannot be used alone as a pagination cursor. We page by the genuinely
      // chronological `createdAt` column instead, with `id` only as a tiebreaker for the
      // rare case where two rows share the same `createdAt` timestamp. The external cursor
      // contract (an opaque `id` string) is unchanged, so we resolve `startingAfter` to its
      // row's `createdAt` via a correlated subquery rather than reading the value into JS
      // and rebinding it as a query parameter: drizzle's default "date" mode maps
      // `timestamptz` to a JS `Date`, which only carries millisecond precision, while
      // Postgres stores microseconds. Round-tripping through `Date` truncates the cursor's
      // `createdAt` downward, which made the cursor row satisfy `created_at > <truncated
      // cursor>` against its own true (higher-precision) stored value and reappear on the
      // next page. Comparing entirely inside Postgres via subquery avoids that precision
      // loss.
      const cursorCreatedAt = this.db
        .select({ createdAt: schema.webhookEndpoint.createdAt })
        .from(schema.webhookEndpoint)
        .where(eq(schema.webhookEndpoint.id, params.startingAfter));

      const [cursorExists] = await this.db
        .select({ id: schema.webhookEndpoint.id })
        .from(schema.webhookEndpoint)
        .where(and(eq(schema.webhookEndpoint.id, params.startingAfter), eq(schema.webhookEndpoint.merchantId, merchantId)));

      // A nonexistent/foreign cursor is treated the same way the rest of the codebase's
      // pagination (plans/subscriptions/customers services) treats a bad `startingAfter`:
      // no error is thrown, and the filter simply yields no further rows. Since this cursor
      // matches nothing, `gt(id, startingAfter)` alone (a condition guaranteed false against
      // every real UUID that would otherwise be excluded) keeps that "empty tail" behavior
      // without needing an `AppException`.
      if (cursorExists) {
        conditions.push(
          or(
            sql`${schema.webhookEndpoint.createdAt} > (${cursorCreatedAt})`,
            and(sql`${schema.webhookEndpoint.createdAt} = (${cursorCreatedAt})`, gt(schema.webhookEndpoint.id, params.startingAfter)),
          )!,
        );
      } else {
        conditions.push(gt(schema.webhookEndpoint.id, params.startingAfter));
      }
    }

    const rows = await this.db
      .select()
      .from(schema.webhookEndpoint)
      .where(and(...conditions))
      .orderBy(asc(schema.webhookEndpoint.createdAt), asc(schema.webhookEndpoint.id))
      .limit(params.limit + 1);

    return rows.map(({ signingSecret: _s, ...rest }) => rest);
  }

  async update(merchantId: string, id: string, body: UpdateWebhookEndpointDto): Promise<Omit<WebhookEndpointRow, "signingSecret">> {
    const existing = await this.requireOwned(merchantId, id);
    const [updated] = await this.db
      .update(schema.webhookEndpoint)
      .set({
        url: body.url ?? existing.url,
        enabledEvents: body.enabledEvents ?? existing.enabledEvents,
        status: body.status ?? existing.status,
        updatedAt: new Date(),
      })
      .where(eq(schema.webhookEndpoint.id, id))
      .returning();
    const { signingSecret: _s, ...rest } = updated;
    return rest;
  }

  async delete(merchantId: string, id: string): Promise<void> {
    await this.requireOwned(merchantId, id);
    await this.db.delete(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.id, id));
  }

  private async requireOwned(merchantId: string, id: string): Promise<WebhookEndpointRow> {
    const [existing] = await this.db
      .select()
      .from(schema.webhookEndpoint)
      .where(and(eq(schema.webhookEndpoint.id, id), eq(schema.webhookEndpoint.merchantId, merchantId)));
    if (!existing) {
      throw new AppException({ type: "invalid_request_error", code: "webhook_endpoint_not_found", message: "No webhook endpoint with that id exists for this merchant.", param: "id", status: 404 });
    }
    return existing;
  }
}
