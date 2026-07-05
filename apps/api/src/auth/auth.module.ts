import { Module, forwardRef } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { NonceStore } from "./nonce.store.js";
import { SessionGuard } from "./session.guard.js";
import { AuthContextService } from "./auth-context.service.js";
import { ApiKeysModule } from "../api-keys/api-keys.module.js";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: { expiresIn: "7d" },
      }),
    }),
    forwardRef(() => ApiKeysModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, NonceStore, SessionGuard, AuthContextService],
  exports: [SessionGuard, JwtModule, AuthContextService],
})
export class AuthModule {}
