import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 20-byte hex address");
const uintStringSchema = z.string().regex(/^[0-9]+$/, "must be a non-negative integer string");

export const PreparePlanQuerySchema = z.object({
  payoutSplit: addressSchema,
  token: addressSchema,
  amount: uintStringSchema,
  period: uintStringSchema,
  trial: uintStringSchema,
});
export type PreparePlanQuery = z.infer<typeof PreparePlanQuerySchema>;

export const PrepareSubscribeQuerySchema = z.object({
  planId: z.string().min(1),
  owner: addressSchema,
});
export type PrepareSubscribeQuery = z.infer<typeof PrepareSubscribeQuerySchema>;
