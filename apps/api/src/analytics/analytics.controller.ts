import { Controller, Get, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "../merchants/merchants.service.js";
import { AnalyticsService } from "./analytics.service.js";
import { AppException } from "../common/errors.js";

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

@Controller("v1/analytics")
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

  private async resolveMerchantId(request: FastifyRequest): Promise<string> {
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

  @Get("summary")
  async summary(@Req() request: FastifyRequest) {
    const merchantId = await this.resolveMerchantId(request);
    const latest = await this.analyticsService.getLatestRow(merchantId);
    const window = await this.analyticsService.getWindowSum(merchantId, daysAgo(30), today());
    const activeSubs = latest.activeSubs;
    const arpuUsd = activeSubs > 0 ? Number(latest.mrrUsd) / activeSubs : 0;

    return {
      mrr_usd: latest.mrrUsd,
      arr_usd: latest.arrUsd,
      active_subscriptions: activeSubs,
      arpu_usd: arpuUsd.toFixed(6),
      gross_volume_30d_usd: window.grossVolumeUsd.toFixed(6),
      fee_revenue_30d_usd: window.feeRevenueUsd.toFixed(6),
      churn_rate_30d: 0, // computed properly once Task 5's churn logic is wired in below
    };
  }

  @Get("mrr")
  async mrr(@Query() query: { from?: string; to?: string; interval?: string }, @Req() request: FastifyRequest) {
    const merchantId = await this.resolveMerchantId(request);
    const from = query.from ?? daysAgo(30);
    const to = query.to ?? today();
    const rows = await this.analyticsService.getRowsInRange(merchantId, from, to);
    return {
      data: rows.map((r) => ({ date: r.date, mrr_usd: r.mrrUsd, arr_usd: r.arrUsd })),
    };
  }
}
