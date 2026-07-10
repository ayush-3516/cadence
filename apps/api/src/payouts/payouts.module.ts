import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { PayoutsController } from "./payouts.controller.js";
import { PayoutsService } from "./payouts.service.js";

@Module({
  imports: [AuthModule, MerchantsModule],
  controllers: [PayoutsController],
  providers: [PayoutsService],
})
export class PayoutsModule {}
