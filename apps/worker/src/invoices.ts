import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { schema } from "@cadence/db";
import type { DbClient } from "@cadence/db";
import type { InvoicePdfParams } from "./invoice-pdf.js";

export interface GenerateInvoiceDeps {
  db: DbClient;
  renderInvoicePdf: (params: InvoicePdfParams) => Promise<Buffer>;
  uploadInvoicePdf: (bucket: string, key: string, body: Buffer) => Promise<string>;
  s3Bucket: string;
  s3PublicBaseUrl: string;
}

export interface GenerateInvoiceParams {
  merchantId: string;
  merchantName: string;
  subscriberAddress: string;
  onchainSubId: string;
  onchainPlanId: string;
  amount: bigint;
  feeBps: bigint;
  token: string;
  periodEnd: Date;
  txHash: string;
  chainId: number;
}

function formatInvoiceNumber(n: number): string {
  return `CAD-${n.toString().padStart(6, "0")}`;
}

export async function generateInvoice(deps: GenerateInvoiceDeps, params: GenerateInvoiceParams): Promise<void> {
  const platformFee = (params.amount * params.feeBps) / 10_000n;
  const net = params.amount - platformFee;

  const [{ invoiceSequence }] = await deps.db
    .update(schema.merchant)
    .set({ invoiceSequence: sql`${schema.merchant.invoiceSequence} + 1` })
    .where(eq(schema.merchant.id, params.merchantId))
    .returning({ invoiceSequence: schema.merchant.invoiceSequence });

  const number = formatInvoiceNumber(invoiceSequence);

  const pdfBuffer = await deps.renderInvoicePdf({
    invoiceNumber: number,
    merchantName: params.merchantName,
    subscriberAddress: params.subscriberAddress,
    amount: params.amount,
    platformFee,
    net,
    token: params.token,
    periodEnd: params.periodEnd,
    txHash: params.txHash,
    chainId: params.chainId,
  });

  // The invoice id is generated client-side (rather than left to the DB's
  // default) so the S3 key can be computed — and the upload attempted — BEFORE
  // any row is persisted. This guarantees that a render/upload failure leaves
  // no invoice row behind (see invoices.test.ts's "propagates an error"
  // case): generateInvoice is all-or-nothing from the caller's perspective.
  const invoiceId = randomUUID();
  const key = `invoices/${params.merchantId}/${invoiceId}.pdf`;
  const uploadedKey = await deps.uploadInvoicePdf(deps.s3Bucket, key, pdfBuffer);
  const pdfUrl = `${deps.s3PublicBaseUrl}/${uploadedKey.replace(deps.s3Bucket + "/", "")}`;

  await deps.db.insert(schema.invoice).values({
    id: invoiceId,
    merchantId: params.merchantId,
    number,
    pdfUrl,
    txHash: params.txHash,
    amount: params.amount.toString(),
    platformFee: platformFee.toString(),
    net: net.toString(),
    onchainSubId: params.onchainSubId,
    onchainPlanId: params.onchainPlanId,
  });
}
