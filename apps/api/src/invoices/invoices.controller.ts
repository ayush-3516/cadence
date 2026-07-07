import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { InvoicesService, type InvoiceRow } from "./invoices.service.js";
import { parsePaginationQuery, buildPageEnvelope } from "../common/pagination.js";
import { AppException } from "../common/errors.js";

function toResponse(row: InvoiceRow) {
  return {
    id: row.id,
    number: row.number,
    pdf_url: row.pdfUrl,
    tx_hash: row.txHash,
    amount: row.amount,
    platform_fee: row.platformFee,
    net: row.net,
    onchain_sub_id: row.onchainSubId,
    onchain_plan_id: row.onchainPlanId,
    issued_at: row.issuedAt.toISOString(),
  };
}

@Controller("v1/invoices")
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveMerchantId(request: FastifyRequest): Promise<string> {
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
  async list(@Query() query: { subscriber?: string; limit?: string; starting_after?: string }, @Req() request: FastifyRequest) {
    const auth = await this.authContext.resolve(request);
    const merchantId = await this.resolveMerchantId(request);

    if (auth.keyType === "publishable" && !query.subscriber) {
      throw new AppException({
        type: "invalid_request_error",
        code: "subscriber_required",
        message: "A publishable key must supply the `subscriber` query parameter to list invoices.",
        param: "subscriber",
      });
    }

    const { limit, startingAfter } = parsePaginationQuery(query);
    const rows = await this.invoicesService.listForMerchant(merchantId, { subscriberAddress: query.subscriber, limit, startingAfter });
    return buildPageEnvelope(rows.map(toResponse), limit);
  }

  @Get(":id")
  async getById(@Param("id") id: string, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveMerchantId(request);
    const row = await this.invoicesService.getById(merchantId, id);
    if (!row) {
      throw new AppException({ type: "invalid_request_error", code: "invoice_not_found", message: "No invoice with that id exists for this merchant.", param: "id", status: 404 });
    }
    return toResponse(row);
  }
}
