import { Body, Controller, Post, Res } from "@nestjs/common";
import { FastifyReply } from "fastify";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service.js";
import { VerifySiweDto } from "./auth.dto.js";
import { SESSION_COOKIE_NAME } from "./session.guard.js";

@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
  ) {}

  @Post("nonce")
  nonce(): { nonce: string } {
    return { nonce: this.authService.issueNonce() };
  }

  @Post("verify")
  async verify(@Body() body: VerifySiweDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const { address } = await this.authService.verify(body.message, body.signature);
    const token = this.jwtService.sign({ address });

    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });

    return { address };
  }
}
