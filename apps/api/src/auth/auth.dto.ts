import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const VerifySiweSchema = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
});

export class VerifySiweDto extends createZodDto(VerifySiweSchema) {}
