import { Cadence } from "@cadence/sdk";

export const cadence = new Cadence({
  apiKey: process.env.NEXT_PUBLIC_PORTAL_PUBLISHABLE_KEY ?? "",
  baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000",
});
