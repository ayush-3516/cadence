import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { FastifyRequest } from "fastify";
import { AppException } from "../common/errors.js";

export const SESSION_COOKIE_NAME = "cadence_session";

export interface SessionPayload {
  address: string;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies?.[SESSION_COOKIE_NAME];

    if (!token) {
      throw new AppException({
        type: "authentication_error",
        code: "missing_session",
        message: "No active session. Sign in with your wallet first.",
      });
    }

    try {
      const payload = this.jwtService.verify<SessionPayload>(token);
      (request as FastifyRequest & { session: SessionPayload }).session = { address: payload.address };
      return true;
    } catch {
      throw new AppException({
        type: "authentication_error",
        code: "invalid_session",
        message: "Session is invalid or expired.",
      });
    }
  }
}
