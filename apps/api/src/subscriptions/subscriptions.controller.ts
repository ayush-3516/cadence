import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { SubscriptionsService } from "./subscriptions.service.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/subscriptions")
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveSecretCallerOwnerAddress(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType === "session") return auth.ownerAddress;

    if (auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }

    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account found for this API key." });
    }
    return merchant.ownerAddress;
  }

  @Get()
  async list(
    @Query() query: { limit?: string; starting_after?: string; status?: string; plan_id?: string; subscriber?: string },
    @Req() request: FastifyRequest,
  ) {
    const ownerAddress = await this.resolveSecretCallerOwnerAddress(request);
    const { limit, startingAfter } = parsePaginationQuery(query);

    const rows = await this.subscriptionsService.list(ownerAddress, {
      limit,
      startingAfter,
      status: query.status,
      planId: query.plan_id,
      subscriber: query.subscriber,
    });
    return buildPageEnvelope(rows, limit);
  }

  @Get(":onchainId")
  async getByOnchainId(@Param("onchainId") onchainId: string, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveSecretCallerOwnerAddress(request);
    return this.subscriptionsService.getByOnchainId(ownerAddress, onchainId);
  }
}
