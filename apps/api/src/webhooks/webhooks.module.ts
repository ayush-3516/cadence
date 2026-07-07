import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module.js";
import { MerchantsModule } from "../merchants/merchants.module.js";
import { DB_CLIENT } from "../db/db.module.js";
import { WebhookEndpointsController } from "./webhook-endpoints.controller.js";
import { WebhookEndpointsService } from "./webhook-endpoints.service.js";

@Module({
  imports: [AuthModule, forwardRef(() => MerchantsModule), ConfigModule],
  controllers: [WebhookEndpointsController],
  providers: [
    {
      provide: WebhookEndpointsService,
      inject: [DB_CLIENT, ConfigService],
      useFactory: (dbClient: unknown, config: ConfigService) =>
        new WebhookEndpointsService(dbClient as never, config.getOrThrow<string>("WEBHOOK_SIGNING_ROTATION_KEY")),
    },
  ],
  exports: [WebhookEndpointsService],
})
export class WebhooksModule {}
