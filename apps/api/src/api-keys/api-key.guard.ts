import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { ApiKeysService } from "./api-keys.service.js";
import { AppException } from "../common/errors.js";

export interface ApiKeyContext {
  merchantId: string;
  livemode: boolean;
  keyType: "secret" | "publishable";
}

// Not yet mounted on any route via @UseGuards() in this phase — GET
// /v1/merchants/me verifies bearer keys inline instead (see
// MerchantsController.me), since it must also accept a session cookie.
// This guard is a carried-forward interface for a later sub-project that
// adds routes authenticated by API key alone.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      throw new AppException({
        type: "authentication_error",
        code: "missing_api_key",
        message: "Missing Authorization: Bearer <key> header.",
      });
    }

    const rawKey = authHeader.slice("Bearer ".length);
    const keyRow = await this.apiKeysService.findActiveByRawKey(rawKey);

    if (!keyRow) {
      throw new AppException({
        type: "authentication_error",
        code: "invalid_api_key",
        message: "The API key is invalid or has been revoked.",
      });
    }

    await this.apiKeysService.touchLastUsed(keyRow.id, keyRow.lastUsedAt);

    (request as FastifyRequest & { apiKeyContext: ApiKeyContext }).apiKeyContext = {
      merchantId: keyRow.merchantId,
      livemode: keyRow.livemode,
      keyType: keyRow.type,
    };
    return true;
  }
}
