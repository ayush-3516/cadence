import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@cadence/db";
import { decryptSecret } from "@cadence/shared";
import type { DbClient } from "@cadence/db";

const RETRY_LADDER_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 5 * 3_600_000, 10 * 3_600_000, 24 * 3_600_000];

export async function deliverWebhook(db: DbClient, deliveryId: string, webhookSigningRotationKey: string): Promise<void> {
  const [delivery] = await db.select().from(schema.webhookDelivery).where(eq(schema.webhookDelivery.id, deliveryId));
  if (!delivery) return; // Deleted or never created — nothing to do.

  const [endpoint] = await db.select().from(schema.webhookEndpoint).where(eq(schema.webhookEndpoint.id, delivery.endpointId));
  if (!endpoint || endpoint.status !== "enabled") {
    await db.update(schema.webhookDelivery).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.webhookDelivery.id, deliveryId));
    return;
  }

  const rawBody = JSON.stringify(delivery.payload);
  const t = Math.floor(Date.now() / 1000);
  const signingSecret = decryptSecret(endpoint.signingSecret, webhookSigningRotationKey);
  const sig = createHmac("sha256", signingSecret).update(`${t}.${rawBody}`).digest("hex");

  let responseCode: number | null = null;
  let responseBody: string | null = null;
  let succeeded = false;

  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cadence-Signature": `t=${t},v1=${sig}`,
        "Cadence-Event-Id": (delivery.payload as { id: string }).id,
      },
      body: rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    responseCode = response.status;
    responseBody = (await response.text()).slice(0, 2000); // cap stored body size
    succeeded = response.status >= 200 && response.status < 300;
  } catch {
    responseCode = null;
    responseBody = "request failed (network error or timeout)";
    succeeded = false;
  }

  const attempts = delivery.attempts + 1;

  if (succeeded) {
    await db
      .update(schema.webhookDelivery)
      .set({ status: "succeeded", attempts, responseCode, responseBody, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, deliveryId));
    return;
  }

  if (attempts < RETRY_LADDER_MS.length) {
    const nextAttemptAt = new Date(Date.now() + RETRY_LADDER_MS[attempts]);
    await db
      .update(schema.webhookDelivery)
      .set({ status: "pending", attempts, nextAttemptAt, responseCode, responseBody, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, deliveryId));
  } else {
    await db
      .update(schema.webhookDelivery)
      .set({ status: "dead", attempts, responseCode, responseBody, updatedAt: new Date() })
      .where(eq(schema.webhookDelivery.id, deliveryId));
  }
}
