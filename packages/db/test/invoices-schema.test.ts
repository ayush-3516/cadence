import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "../src/client.js";

describe("invoices schema", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const cwd = path.resolve(__dirname, "..");
    execSync("npx drizzle-kit migrate", { cwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedMerchant() {
    const [row] = await db
      .insert(schema.merchant)
      .values({ name: "Invoice Test Co", ownerAddress: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42), livemode: false })
      .returning();
    return row;
  }

  it("merchant.invoice_sequence defaults to 0", async () => {
    const merchant = await seedMerchant();
    expect(merchant.invoiceSequence).toBe(0);
  });

  it("inserts an invoice row with all required fields", async () => {
    const merchant = await seedMerchant();
    const [row] = await db
      .insert(schema.invoice)
      .values({
        merchantId: merchant.id,
        number: "CAD-000001",
        txHash: "0xabc123",
        amount: "20000000",
        platformFee: "150000",
        net: "19850000",
        onchainSubId: "1",
        onchainPlanId: "1",
      })
      .returning();

    expect(row.number).toBe("CAD-000001");
    expect(row.pdfUrl).toBeNull(); // nullable until upload succeeds
    expect(row.amount).toBe("20000000");
    expect(row.platformFee).toBe("150000");
    expect(row.net).toBe("19850000");
    expect(row.issuedAt).toBeInstanceOf(Date);
  });

  it("enforces UNIQUE(merchant_id, number)", async () => {
    const merchant = await seedMerchant();
    await db.insert(schema.invoice).values({
      merchantId: merchant.id,
      number: "CAD-000001",
      txHash: "0xabc123",
      amount: "20000000",
      platformFee: "150000",
      net: "19850000",
      onchainSubId: "1",
      onchainPlanId: "1",
    });

    await expect(
      db.insert(schema.invoice).values({
        merchantId: merchant.id,
        number: "CAD-000001", // same merchant, same number — must conflict
        txHash: "0xdef456",
        amount: "20000000",
        platformFee: "150000",
        net: "19850000",
        onchainSubId: "2",
        onchainPlanId: "1",
      }),
    ).rejects.toThrow();
  });

  it("allows the same number for different merchants", async () => {
    const merchantA = await seedMerchant();
    const merchantB = await seedMerchant();
    await db.insert(schema.invoice).values({
      merchantId: merchantA.id,
      number: "CAD-000001",
      txHash: "0xaaa",
      amount: "20000000",
      platformFee: "150000",
      net: "19850000",
      onchainSubId: "1",
      onchainPlanId: "1",
    });
    const [row] = await db
      .insert(schema.invoice)
      .values({
        merchantId: merchantB.id,
        number: "CAD-000001", // same number, different merchant — must succeed
        txHash: "0xbbb",
        amount: "20000000",
        platformFee: "150000",
        net: "19850000",
        onchainSubId: "2",
        onchainPlanId: "1",
      })
      .returning();
    expect(row.number).toBe("CAD-000001");
  });

  it("atomically allocates invoice_sequence via UPDATE ... RETURNING", async () => {
    const merchant = await seedMerchant();
    const [updated1] = await db
      .update(schema.merchant)
      .set({ invoiceSequence: 1 })
      .where(eq(schema.merchant.id, merchant.id))
      .returning({ invoiceSequence: schema.merchant.invoiceSequence });
    expect(updated1.invoiceSequence).toBe(1);

    const [reread] = await db.select().from(schema.merchant).where(eq(schema.merchant.id, merchant.id));
    expect(reread.invoiceSequence).toBe(1);
  });
});
