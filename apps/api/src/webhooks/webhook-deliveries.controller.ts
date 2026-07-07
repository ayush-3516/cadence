import { Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { WebhookDeliveriesService } from "./webhook-deliveries.service.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/webhook-deliveries")
export class WebhookDeliveriesController {
  constructor(
    private readonly webhookDeliveriesService: WebhookDeliveriesService,
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

  @Get()
  async list(@Query() query: { status?: string; limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.webhookDeliveriesService.listForMerchant(merchantId, { status: query.status, limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }

  @Post(":id/replay")
  @HttpCode(200)
  async replay(@Param("id") id: string, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.webhookDeliveriesService.replay(merchantId, id);
  }
}
