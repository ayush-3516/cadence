import { Body, Controller, Delete, Get, Inject, Param, Post, Req, UseGuards, forwardRef } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { SessionGuard, SessionPayload } from "../auth/session.guard.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { ApiKeysService } from "./api-keys.service.js";
import { CreateApiKeyDto } from "./api-keys.dto.js";
import { AppException } from "../common/errors.js";

type RequestWithSession = FastifyRequest & { session: SessionPayload };

@Controller("v1/api-keys")
@UseGuards(SessionGuard)
export class ApiKeysController {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    @Inject(forwardRef(() => MerchantsService)) private readonly merchantsService: MerchantsService,
  ) {}

  private async resolveMerchantId(address: string): Promise<string> {
    const merchant = await this.merchantsService.findByOwnerAddress(address, false);
    if (!merchant) {
      throw new AppException({
        type: "invalid_request_error",
        code: "merchant_not_found",
        message: "Create a merchant account before creating API keys.",
      });
    }
    return merchant.id;
  }

  @Post()
  async create(@Body() body: CreateApiKeyDto, @Req() request: RequestWithSession) {
    const merchantId = await this.resolveMerchantId(request.session.address);
    return this.apiKeysService.create(merchantId, body.type, false);
  }

  @Get()
  async list(@Req() request: RequestWithSession) {
    const merchantId = await this.resolveMerchantId(request.session.address);
    return this.apiKeysService.listForMerchant(merchantId);
  }

  @Delete(":id")
  async revoke(@Param("id") id: string, @Req() request: RequestWithSession) {
    const merchantId = await this.resolveMerchantId(request.session.address);
    await this.apiKeysService.revoke(merchantId, id);
    return { revoked: true };
  }
}
