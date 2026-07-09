export class ApiError extends Error {
  readonly type: string;
  readonly code: string;
  readonly param?: string;
  readonly status: number;

  constructor(params: { type: string; code: string; message: string; param?: string; status: number }) {
    super(params.message);
    this.name = "ApiError";
    this.type = params.type;
    this.code = params.code;
    this.param = params.param;
    this.status = params.status;
  }
}

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

export async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  const text = await response.clone().text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!response.ok) {
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const envelope = (parsed as { error: { type: string; code: string; message: string; param?: string } }).error;
      throw new ApiError({ ...envelope, status: response.status });
    }
    throw new ApiError({ type: "api_error", code: "unknown_error", message: `Request failed with status ${response.status}`, status: response.status });
  }

  return parsed;
}
