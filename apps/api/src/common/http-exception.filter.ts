import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { FastifyReply } from "fastify";
import { AppException } from "./errors.js";

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    if (exception instanceof AppException) {
      reply.status(exception.status).send(exception.toEnvelope());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === "string" ? response : ((response as { message?: string }).message ?? exception.message);
      reply.status(status).send({
        error: {
          type: status === HttpStatus.UNAUTHORIZED ? "authentication_error" : "invalid_request_error",
          code: "http_exception",
          message: Array.isArray(message) ? message.join("; ") : message,
        },
      });
      return;
    }

    reply.status(500).send({
      error: {
        type: "api_error",
        code: "internal_error",
        message: "An unexpected error occurred.",
      },
    });
  }
}
