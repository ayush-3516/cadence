import { Controller, Get, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { AppException } from "../common/errors.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { PayoutsService } from "./payouts.service.js";

@Controller("v1/payouts")
export class PayoutsController {
  constructor(
    private readonly payoutsService: PayoutsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveOwnerAddress(request: FastifyRequest): Promise<string> {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType !== "session" && auth.keyType !== "secret") {
      throw new AppException({ type: "permission_error", code: "key_type_not_allowed", message: "This endpoint requires a secret API key." });
    }
    if (auth.keyType === "session") return auth.ownerAddress;

    const merchant = await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists." });
    }
    return merchant.ownerAddress;
  }

  @Get()
  async list(@Query() query: { limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveOwnerAddress(request);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.payoutsService.list(ownerAddress, { limit, startingAfter });
    return buildPageEnvelope(rows, limit);
  }
}
