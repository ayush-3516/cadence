import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
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
    if (params.startingAfter !== null) conditions.push(gt(schema.webhookEndpoint.id, params.startingAfter));

    const rows = await this.db
      .select()
      .from(schema.webhookEndpoint)
      .where(and(...conditions))
      .orderBy(asc(schema.webhookEndpoint.id))
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
