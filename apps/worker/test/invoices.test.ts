import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type DbClient } from "@cadence/db";
import { generateInvoice } from "../src/invoices.js";

describe("generateInvoice", () => {
  let container: StartedPostgreSqlContainer;
  let db: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").withDatabase("cadence_test").start();
    const url = container.getConnectionUri();
    const dbCwd = path.resolve(__dirname, "../../../packages/db");
    execSync("npx drizzle-kit migrate", { cwd: dbCwd, env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
    db = createDbClient(url);
  }, 60_000);

  afterAll(async () => {
    await (db as DbClient & { $client: { end(): Promise<void> } }).$client.end();
    await container.stop();
  });

  async function seedMerchant() {
    const [row] = await db
      .insert(schema.merchant)
      .values({ name: "Invoice Gen Test Co", ownerAddress: `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(42, "0").slice(0, 42), livemode: false })
      .returning();
    return row;
  }

  it("allocates a sequential invoice number, computes fee/net, and persists the row", async () => {
    const merchant = await seedMerchant();
    const uploadInvoicePdf = vi.fn().mockResolvedValue("invoices/x/y.pdf");
    const renderInvoicePdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-fake"));

    await generateInvoice(
      { db, uploadInvoicePdf, renderInvoicePdf, s3Bucket: "test-bucket", s3PublicBaseUrl: "http://localhost:9000/test-bucket" },
      {
        merchantId: merchant.id,
        merchantName: merchant.name,
        subscriberAddress: "0x1234567890123456789012345678901234567890",
        onchainSubId: "1",
        onchainPlanId: "1",
        amount: 20_000_000n,
        feeBps: 75n,
        token: "USDC",
        periodEnd: new Date("2026-08-01T00:00:00Z"),
        txHash: "0xabc123",
        chainId: 84532,
      },
    );

    const [row] = await db.select().from(schema.invoice).where(eq(schema.invoice.merchantId, merchant.id));
    expect(row.number).toBe("CAD-000001");
    expect(row.amount).toBe("20000000");
    expect(row.platformFee).toBe("150000"); // 20_000_000 * 75 / 10_000
    expect(row.net).toBe("19850000");
    expect(row.pdfUrl).toBe("http://localhost:9000/test-bucket/invoices/x/y.pdf");
    expect(row.txHash).toBe("0xabc123");

    const [updatedMerchant] = await db.select().from(schema.merchant).where(eq(schema.merchant.id, merchant.id));
    expect(updatedMerchant.invoiceSequence).toBe(1);
  });

  it("allocates sequential numbers across multiple invoices for the same merchant", async () => {
    const merchant = await seedMerchant();
    const deps = {
      db,
      uploadInvoicePdf: vi.fn().mockResolvedValue("invoices/x/y.pdf"),
      renderInvoicePdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-fake")),
      s3Bucket: "test-bucket",
      s3PublicBaseUrl: "http://localhost:9000/test-bucket",
    };
    const baseParams = {
      merchantId: merchant.id,
      merchantName: merchant.name,
      subscriberAddress: "0x1234567890123456789012345678901234567890",
      onchainSubId: "1",
      onchainPlanId: "1",
      amount: 20_000_000n,
      feeBps: 75n,
      token: "USDC",
      periodEnd: new Date("2026-08-01T00:00:00Z"),
      chainId: 84532,
    };

    await generateInvoice(deps, { ...baseParams, txHash: "0xaaa" });
    await generateInvoice(deps, { ...baseParams, txHash: "0xbbb" });

    const rows = await db.select().from(schema.invoice).where(eq(schema.invoice.merchantId, merchant.id));
    const numbers = rows.map((r) => r.number).sort();
    expect(numbers).toEqual(["CAD-000001", "CAD-000002"]);
  });

  it("propagates an error if the render/upload step throws, without persisting a row", async () => {
    const merchant = await seedMerchant();
    const uploadInvoicePdf = vi.fn().mockRejectedValue(new Error("S3 unreachable"));
    const renderInvoicePdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-fake"));

    await expect(
      generateInvoice(
        { db, uploadInvoicePdf, renderInvoicePdf, s3Bucket: "test-bucket", s3PublicBaseUrl: "http://localhost:9000/test-bucket" },
        {
          merchantId: merchant.id,
          merchantName: merchant.name,
          subscriberAddress: "0x1234567890123456789012345678901234567890",
          onchainSubId: "1",
          onchainPlanId: "1",
          amount: 20_000_000n,
          feeBps: 75n,
          token: "USDC",
          periodEnd: new Date("2026-08-01T00:00:00Z"),
          txHash: "0xabc123",
          chainId: 84532,
        },
      ),
    ).rejects.toThrow("S3 unreachable");

    const rows = await db.select().from(schema.invoice).where(eq(schema.invoice.merchantId, merchant.id));
    expect(rows).toHaveLength(0);
  });
});
