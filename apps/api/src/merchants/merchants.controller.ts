import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { SessionGuard, SessionPayload } from "../auth/session.guard.js";
import { AuthContextService } from "../auth/auth-context.service.js";
import { MerchantsService } from "./merchants.service.js";
import { CreateMerchantDto } from "./merchants.dto.js";
import { AppException } from "../common/errors.js";

type RequestWithSession = FastifyRequest & { session: SessionPayload };

@Controller("v1/merchants")
export class MerchantsController {
  constructor(
    private readonly merchantsService: MerchantsService,
    private readonly authContext: AuthContextService,
  ) {}

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
  async me(@Req() request: FastifyRequest) {
    const auth = await this.authContext.resolve(request);
    const merchant =
      auth.keyType === "session"
        ? await this.merchantsService.findByOwnerAddress(auth.ownerAddress, false)
        : await this.merchantsService.findByOwnerAddressById(auth.merchantId!);

    if (!merchant) {
      throw new AppException({
        type: "invalid_request_error",
        code: "merchant_not_found",
        message:
          auth.keyType === "session"
            ? "No merchant account exists for this session yet."
            : "No merchant account found for this API key.",
      });
    }
    return merchant;
  }
}
