import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module.js";
import { CustomersController } from "./customers.controller.js";
import { CustomersService } from "./customers.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule), SubscriptionsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
