import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(rawBody: string, header: string, secret: string): boolean {
  const parts = header.split(",").reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split("=");
    if (key && value) acc[key] = value;
    return acc;
  }, {});

  const timestamp = parts["t"];
  const providedSig = parts["v1"];
  if (!timestamp || !providedSig) return false;

  const expectedSig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  const expectedBuf = Buffer.from(expectedSig, "hex");
  const providedBuf = Buffer.from(providedSig, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
