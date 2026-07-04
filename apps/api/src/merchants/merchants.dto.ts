import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const CreateMerchantSchema = z.object({
  name: z.string().min(1).max(200),
  ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address"),
});

export class CreateMerchantDto extends createZodDto(CreateMerchantSchema) {}
