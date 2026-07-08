export type CadenceErrorType = "authentication_error" | "permission_error" | "invalid_request_error" | "rate_limit_error" | "api_error";

export class CadenceError extends Error {
  readonly type: CadenceErrorType;
  readonly code: string;
  readonly param?: string;
  readonly status: number;

  constructor(params: { type: CadenceErrorType; code: string; message: string; param?: string; status: number }) {
    super(params.message);
    this.name = "CadenceError";
    this.type = params.type;
    this.code = params.code;
    this.param = params.param;
    this.status = params.status;
  }
}
