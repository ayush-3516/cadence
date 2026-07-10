import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_PIPE } from "@nestjs/core";
import { ZodValidationPipe } from "nestjs-zod";
import { DbModule } from "./db/db.module.js";
import { HealthController } from "./health/health.controller.js";
import { AppExceptionFilter } from "./common/http-exception.filter.js";
import { AuthModule } from "./auth/auth.module.js";
import { MerchantsModule } from "./merchants/merchants.module.js";
import { ApiKeysModule } from "./api-keys/api-keys.module.js";
import { PlansModule } from "./plans/plans.module.js";
import { SubscriptionsModule } from "./subscriptions/subscriptions.module.js";
import { CustomersModule } from "./customers/customers.module.js";
import { WebhooksModule } from "./webhooks/webhooks.module.js";
import { InvoicesModule } from "./invoices/invoices.module.js";
import { AnalyticsModule } from "./analytics/analytics.module.js";
import { PrepareModule } from "./prepare/prepare.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ".env.local" }),
    DbModule,
    AuthModule,
    MerchantsModule,
    ApiKeysModule,
    PlansModule,
    SubscriptionsModule,
    CustomersModule,
    WebhooksModule,
    InvoicesModule,
    AnalyticsModule,
    PrepareModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
