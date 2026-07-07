import PDFDocument from "pdfkit";

export interface InvoicePdfParams {
  invoiceNumber: string;
  merchantName: string;
  subscriberAddress: string;
  amount: bigint;
  platformFee: bigint;
  net: bigint;
  token: string;
  periodEnd: Date;
  txHash: string;
  chainId: number;
}

const EXPLORER_BASE_URL: Record<number, string> = {
  84532: "https://sepolia.basescan.org/tx/",
  8453: "https://basescan.org/tx/",
};

export function renderInvoicePdf(params: InvoicePdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("Invoice", { align: "left" });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice Number: ${params.invoiceNumber}`);
    doc.text(`Merchant: ${params.merchantName}`);
    doc.text(`Customer: ${params.subscriberAddress}`);
    doc.text(`Billing period ending: ${params.periodEnd.toISOString()}`);
    doc.moveDown();
    doc.text(`Amount: ${params.amount.toString()} ${params.token} (smallest unit)`);
    doc.text(`Platform fee: ${params.platformFee.toString()} ${params.token} (smallest unit)`);
    doc.text(`Net to merchant: ${params.net.toString()} ${params.token} (smallest unit)`);
    doc.moveDown();
    doc.text(`Transaction hash: ${params.txHash}`);
    const explorerBase = EXPLORER_BASE_URL[params.chainId];
    if (explorerBase) {
      doc.fillColor("blue").text(`${explorerBase}${params.txHash}`, { link: `${explorerBase}${params.txHash}`, underline: true });
      doc.fillColor("black");
    }

    doc.end();
  });
}
