import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { SessionGuard, SessionPayload } from "../auth/session.guard.js";
import { MerchantsService } from "./merchants.service.js";
import { CreateMerchantDto } from "./merchants.dto.js";
import { AppException } from "../common/errors.js";

type RequestWithSession = FastifyRequest & { session: SessionPayload };

@Controller("v1/merchants")
export class MerchantsController {
  constructor(private readonly merchantsService: MerchantsService) {}

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
  @UseGuards(SessionGuard)
  async me(@Req() request: RequestWithSession) {
    const merchant = await this.merchantsService.findByOwnerAddress(request.session.address, false);
    if (!merchant) {
      throw new AppException({
        type: "invalid_request_error",
        code: "merchant_not_found",
        message: "No merchant account exists for this session yet.",
      });
    }
    return merchant;
  }
}
