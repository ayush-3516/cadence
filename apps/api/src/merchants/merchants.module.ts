import { Module, forwardRef } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ApiKeysModule } from "../api-keys/api-keys.module.js";
import { MerchantsController } from "./merchants.controller.js";
import { MerchantsService } from "./merchants.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => ApiKeysModule)],
  controllers: [MerchantsController],
  providers: [MerchantsService],
  exports: [MerchantsService],
})
export class MerchantsModule {}
