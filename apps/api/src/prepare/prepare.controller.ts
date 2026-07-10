import { Controller, Get, Query, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AuthContextService } from "../auth/auth-context.service.js";
import { RequireKeyType } from "../auth/require-key-type.decorator.js";
import { AppException } from "../common/errors.js";
import { PrepareService } from "./prepare.service.js";
import { PreparePlanQuerySchema } from "./prepare.dto.js";

@Controller("v1/prepare")
export class PrepareController {
  constructor(
    private readonly prepareService: PrepareService,
    private readonly authContext: AuthContextService,
  ) {}

  // @RequireKeyType sets route metadata only; AuthContextService.resolve only
  // enforces it when called WITH an ExecutionContext, which no @Query()-only
  // handler in this codebase has access to (ExecutionContext comes from a
  // Guard, and none of the key-type routes use one). Every existing
  // @RequireKeyType("secret") caller (see plans.controller.ts's
  // resolveCallerOwnerAddress) re-checks auth.keyType by hand for this exact
  // reason — this mirrors that established pattern, not a decorator-alone
  // check like the plan text implied.
  @Get("plan")
  @RequireKeyType("secret")
  async plan(@Query() query: Record<string, string>, @Req() request: FastifyRequest) {
    const auth = await this.authContext.resolve(request);
    if (auth.keyType !== "secret") {
      throw new AppException({
        type: "permission_error",
        code: "key_type_not_allowed",
        message: "This endpoint requires a secret API key.",
      });
    }

    const params = parsePreparePlanQuery(query);
    return this.prepareService.buildCreatePlanCalldata(params);
  }
}

// PreparePlanQuerySchema.parse throws a raw ZodError, which this codebase's
// global AppExceptionFilter (see ../common/http-exception.filter.ts) does not
// know how to format — it would fall through to a generic 500. Wrapping it in
// an AppException here matches every other validation-failure path in this
// codebase (see plans.service.ts's requireOwnedPlan) and produces a real 400.
function parsePreparePlanQuery(query: Record<string, string>) {
  try {
    return PreparePlanQuerySchema.parse(query);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppException({
        type: "invalid_request_error",
        code: "invalid_query_params",
        message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      });
    }
    throw error;
  }
}
