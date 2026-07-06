import { z } from "zod";
import { createZodDto } from "nestjs-zod";

export const SetCustomerEmailSchema = z.object({
  email: z.string().email(),
});

export class SetCustomerEmailDto extends createZodDto(SetCustomerEmailSchema) {}
