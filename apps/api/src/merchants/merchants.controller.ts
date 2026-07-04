import { Body, Controller, Get, Inject, Post, Req, UseGuards, forwardRef } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtService } from "@nestjs/jwt";
import { SessionGuard, SessionPayload, SESSION_COOKIE_NAME } from "../auth/session.guard.js";
import { MerchantsService } from "./merchants.service.js";
import { CreateMerchantDto } from "./merchants.dto.js";
import { AppException } from "../common/errors.js";
import { ApiKeysService } from "../api-keys/api-keys.service.js";

type RequestWithSession = FastifyRequest & { session: SessionPayload };

@Controller("v1/merchants")
export class MerchantsController {
  constructor(
    private readonly merchantsService: MerchantsService,
    private readonly jwtService: JwtService,
    @Inject(forwardRef(() => ApiKeysService)) private readonly apiKeysService: ApiKeysService,
  ) {}

  @Post()
  @UseGuards(SessionGuard)
  async create(@Body() body: CreateMerchantDto, @Req() request: RequestWithSession) {
    if (body.ownerAddress.toLowerCase() !== request.session.address.toLowerCase()) {
      throw new AppException({
        type: "permission_error",
        code: "address_mismatch",
        message: "ownerAddress must match the signed-in session address.",
        param: "ownerAddress",
      });
    }
    return this.merchantsService.createForSession(request.session.address, body.name);
  }

  @Get("me")
  async me(@Req() request: FastifyRequest) {
    const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (cookieToken) {
      try {
        const payload = this.jwtService.verify<SessionPayload>(cookieToken);
        const merchant = await this.merchantsService.findByOwnerAddress(payload.address, false);
        if (!merchant) {
          throw new AppException({
            type: "invalid_request_error",
            code: "merchant_not_found",
            message: "No merchant account exists for this session yet.",
          });
        }
        return merchant;
      } catch (err) {
        if (err instanceof AppException) throw err;
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
      await this.apiKeysService.touchLastUsed(keyRow.id, keyRow.lastUsedAt);
      const merchant = await this.merchantsService.findByOwnerAddressById(keyRow.merchantId);
      if (!merchant) {
        throw new AppException({
          type: "invalid_request_error",
          code: "merchant_not_found",
          message: "No merchant account found for this API key.",
        });
      }
      return merchant;
    }

    throw new AppException({
      type: "authentication_error",
      code: "missing_credentials",
      message: "Provide either a session cookie or an API key.",
    });
  }
}
