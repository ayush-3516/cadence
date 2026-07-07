import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: config.forcePathStyle,
  });
}

export async function uploadInvoicePdf(client: S3Client, bucket: string, key: string, body: Buffer): Promise<string> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/pdf" }));
  return key; // The caller (invoices.ts) combines this with the configured public base URL to form pdf_url.
}
