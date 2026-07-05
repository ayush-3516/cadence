import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const AttachPlanMetaSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().url().optional(),
  dunningLadder: z.array(z.string()).optional(),
});

export class AttachPlanMetaDto extends createZodDto(AttachPlanMetaSchema) {}
