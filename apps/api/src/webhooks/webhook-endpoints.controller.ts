import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { WebhookEndpointsService } from "./webhook-endpoints.service.js";
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from "./webhook-endpoints.dto.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/webhook-endpoints")
export class WebhookEndpointsController {
  constructor(
    private readonly webhookEndpointsService: WebhookEndpointsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveCallerMerchantId(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType !== "session" && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }
    const merchant =
      auth.keyType === "session"
        ? await this.merchantsService.findByOwnerAddress(auth.ownerAddress, false)
        : await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists." });
    }
    return merchant.id;
  }

  @Post()
  async create(@Body() body: CreateWebhookEndpointDto, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.webhookEndpointsService.create(merchantId, body);
  }

  @Get()
  async list(@Query() query: { limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.webhookEndpointsService.listForMerchant(merchantId, { limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: UpdateWebhookEndpointDto, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.webhookEndpointsService.update(merchantId, id, body);
  }

  @Delete(":id")
  async delete(@Param("id") id: string, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    await this.webhookEndpointsService.delete(merchantId, id);
    return { deleted: true };
  }
}
