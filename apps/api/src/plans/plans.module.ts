import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { PlansController } from "./plans.controller.js";
import { PlansService } from "./plans.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule)],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
