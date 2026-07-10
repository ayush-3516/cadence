import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { RpcClientModule } from "./rpc-client.module.js";
import { PrepareController } from "./prepare.controller.js";
import { PrepareService } from "./prepare.service.js";

@Module({
  imports: [AuthModule, MerchantsModule, RpcClientModule],
  controllers: [PrepareController],
  providers: [PrepareService],
})
export class PrepareModule {}
