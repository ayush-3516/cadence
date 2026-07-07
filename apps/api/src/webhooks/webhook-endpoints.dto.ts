import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const CreateWebhookEndpointSchema = z.object({
  url: z.string().url(),
  enabledEvents: z.array(z.string()).optional(),
});
export class CreateWebhookEndpointDto extends createZodDto(CreateWebhookEndpointSchema) {}

export const UpdateWebhookEndpointSchema = z.object({
  url: z.string().url().optional(),
  enabledEvents: z.array(z.string()).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});
export class UpdateWebhookEndpointDto extends createZodDto(UpdateWebhookEndpointSchema) {}
