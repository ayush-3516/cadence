export type ErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "rate_limit_error"
  | "api_error";

export interface ErrorEnvelope {
  error: {
    type: ErrorType;
    code: string;
    message: string;
    param?: string;
  };
}

const STATUS_BY_TYPE: Record<ErrorType, number> = {
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
  rate_limit_error: 429,
  api_error: 500,
};

export class AppException extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly param?: string;
  readonly status: number;

  constructor(params: { type: ErrorType; code: string; message: string; param?: string; status?: number }) {
    super(params.message);
    this.type = params.type;
    this.code = params.code;
    this.param = params.param;
    this.status = params.status ?? STATUS_BY_TYPE[params.type];
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
      },
    };
  }
}
