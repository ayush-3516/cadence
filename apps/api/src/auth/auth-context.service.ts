import { Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ExecutionContext } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtService } from "@nestjs/jwt";
import { forwardRef } from "@nestjs/common";
import { SessionPayload, SESSION_COOKIE_NAME } from "./session.guard.js";
import { ApiKeysService } from "../api-keys/api-keys.service.js";
import { AppException } from "../common/errors.js";
import { REQUIRE_KEY_TYPE_METADATA_KEY } from "./require-key-type.decorator.js";

export interface AuthContext {
  ownerAddress: string;
  merchantId: string | null;
  keyType: "session" | "secret" | "publishable";
}

@Injectable()
export class AuthContextService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(forwardRef(() => ApiKeysService)) private readonly apiKeysService: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async resolve(request: FastifyRequest, executionContext?: ExecutionContext): Promise<AuthContext> {
    const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (cookieToken) {
      try {
        const payload = this.jwtService.verify<SessionPayload>(cookieToken);
        return { ownerAddress: payload.address, merchantId: null, keyType: "session" };
      } catch {
        // fall through to API-key check below
      }
    }

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const rawKey = authHeader.slice("Bearer ".length);
      const keyRow = await this.apiKeysService.findActiveByRawKey(rawKey);
      if (!keyRow) {
        throw new AppException({
          type: "authentication_error",
          code: "invalid_api_key",
          message: "The API key is invalid or has been revoked.",
        });
      }

      const requiredKeyType = executionContext
        ? this.reflector.get<"secret" | undefined>(REQUIRE_KEY_TYPE_METADATA_KEY, executionContext.getHandler())
        : undefined;
      if (requiredKeyType === "secret" && keyRow.type !== "secret") {
        throw new AppException({
          type: "permission_error",
          code: "key_type_not_allowed",
          message: "This endpoint requires a secret API key.",
        });
      }

      await this.apiKeysService.touchLastUsed(keyRow.id, keyRow.lastUsedAt);
      return { ownerAddress: "", merchantId: keyRow.merchantId, keyType: keyRow.type };
    }

    throw new AppException({
      type: "authentication_error",
      code: "missing_credentials",
      message: "Provide either a session cookie or an API key.",
    });
  }
}
