import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const CreateApiKeySchema = z.object({
  type: z.enum(["secret", "publishable"]),
});

export class CreateApiKeyDto extends createZodDto(CreateApiKeySchema) {}
