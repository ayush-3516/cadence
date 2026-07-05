import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { SubscriptionsService } from "../subscriptions/subscriptions.service.js";
import { CustomersService } from "./customers.service.js";
import { SetCustomerEmailDto } from "./customers.dto.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/customers")
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveCallerOwnerAddress(request: FastifyRequest, requireSecret: boolean): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType === "session") return auth.ownerAddress;

    if (requireSecret && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }

    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account found for this API key." });
    }
    return merchant.ownerAddress;
  }

  private async resolveCallerMerchantId(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
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
  async list(@Query() query: { limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveCallerOwnerAddress(request, true);
    const { limit, startingAfter } = parsePaginationQuery(query);

    const rows = await this.customersService.list(ownerAddress, { limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }

  @Get(":address/subscriptions")
  async getSubscriptions(
    @Param("address") address: string,
    @Query() query: { limit?: string; starting_after?: string },
    @Req() request: FastifyRequest,
  ) {
    const ownerAddress = await this.resolveCallerOwnerAddress(request, false);
    const { limit, startingAfter } = parsePaginationQuery(query);

    const rows = await this.subscriptionsService.list(ownerAddress, { limit, startingAfter, subscriber: address });
    return buildPageEnvelope(rows, limit);
  }

  @Post(":address/email")
  async setEmail(@Param("address") address: string, @Body() body: SetCustomerEmailDto, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveCallerMerchantId(request);
    return this.customersService.setEmail(merchantId, address, body.email);
  }
}
