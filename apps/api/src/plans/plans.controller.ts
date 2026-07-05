import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { RequireKeyType } from "../auth/require-key-type.decorator.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { PlansService } from "./plans.service.js";
import { AttachPlanMetaDto } from "./plan-meta.dto.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

@Controller("v1/plans")
export class PlansController {
  constructor(
    private readonly plansService: PlansService,
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

  @Post(":onchainId/metadata")
  @RequireKeyType("secret")
  async attachMetadata(@Param("onchainId") onchainId: string, @Body() body: AttachPlanMetaDto, @Req() request: FastifyRequest) {
    const auth = await this.authContext.resolve(request, undefined);
    const ownerAddress = await this.resolveCallerOwnerAddress(request, true);
    const merchant = auth.keyType === "session"
      ? await this.merchantsService.findByOwnerAddress(ownerAddress, false)
      : await this.merchantsService.findByOwnerAddressById(auth.merchantId!);
    if (!merchant) {
      throw new AppException({ type: "invalid_request_error", code: "merchant_not_found", message: "No merchant account exists." });
    }
    return this.plansService.attachMetadata(ownerAddress, merchant.id, onchainId, body);
  }

  @Get()
  async list(@Query() query: { limit?: string; starting_after?: string; active?: string }, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveCallerOwnerAddress(request, false);
    const { limit, startingAfter } = parsePaginationQuery(query);
    const active = query.active === undefined ? undefined : query.active === "true";

    const rows = await this.plansService.list(ownerAddress, { limit, startingAfter, active });
    const responses = rows.map((row) => this.plansService.toPlanResponse(row, row.meta));
    return buildPageEnvelope(
      responses.map((r) => ({ ...r, id: r.onchain_plan_id })),
      limit,
    );
  }

  @Get(":onchainId")
  async getByOnchainId(@Param("onchainId") onchainId: string, @Req() request: FastifyRequest) {
    const ownerAddress = await this.resolveCallerOwnerAddress(request, false);
    return this.plansService.getByOnchainId(ownerAddress, onchainId);
  }
}
