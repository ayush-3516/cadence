import { CadenceError, type CadenceErrorType } from "./errors.js";

export type RequestFn = (
  method: string,
  path: string,
  options?: { query?: Record<string, string | undefined>; body?: unknown },
) => Promise<unknown>;

interface ErrorEnvelope {
  error: { type: CadenceErrorType; code: string; message: string; param?: string };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ErrorEnvelope).error === "object" &&
    typeof (value as ErrorEnvelope).error.type === "string" &&
    typeof (value as ErrorEnvelope).error.code === "string"
  );
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function createRequest(apiKey: string, baseUrl: string): RequestFn {
  return async (method, path, options) => {
    const url = buildUrl(baseUrl, path, options?.query);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let body: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      if (isErrorEnvelope(parsed)) {
        throw new CadenceError({ ...parsed.error, status: response.status });
      }
      throw new CadenceError({ type: "api_error", code: "unknown_error", message: `Request failed with status ${response.status}`, status: response.status });
    }

    return parsed;
  };
}
