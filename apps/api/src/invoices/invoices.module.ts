import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule)],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
