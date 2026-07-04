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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ".env.local" }),
    DbModule,
    AuthModule,
    MerchantsModule,
    ApiKeysModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
