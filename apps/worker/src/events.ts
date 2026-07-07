import { and, eq } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";

export interface EmitEventParams {
  merchantId: string;
  type: string;
  data: object;
  onchainTxHash?: string;
}

export async function emitEvent(
  db: DbClient,
  params: EmitEventParams,
  enqueueDelivery: (deliveryId: string) => Promise<void>,
): Promise<void> {
  const [merchant] = await db.select().from(schema.merchant).where(eq(schema.merchant.id, params.merchantId));
  if (!merchant) {
    throw new Error(`emitEvent: no merchant found for id ${params.merchantId}`);
  }

  const [evt] = await db
    .insert(schema.event)
    .values({
      merchantId: params.merchantId,
      type: params.type,
      data: params.data,
      onchainTxHash: params.onchainTxHash,
      livemode: merchant.livemode,
    })
    .returning();

  const endpoints = await db
    .select()
    .from(schema.webhookEndpoint)
    .where(and(eq(schema.webhookEndpoint.merchantId, params.merchantId), eq(schema.webhookEndpoint.status, "enabled")));

  const matching = endpoints.filter((endpoint) => {
    const enabledEvents = endpoint.enabledEvents as string[];
    return enabledEvents.includes("*") || enabledEvents.includes(params.type);
  });

  for (const endpoint of matching) {
    const payload = { id: `evt_${evt.id}`, type: evt.type, created: evt.createdAt.toISOString(), livemode: evt.livemode, data: evt.data };
    const [delivery] = await db
      .insert(schema.webhookDelivery)
      .values({ endpointId: endpoint.id, eventId: evt.id, eventType: params.type, payload })
      .returning();
    await enqueueDelivery(delivery.id);
  }
}
