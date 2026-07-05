import { AppException } from "./errors.js";

export interface PaginationQuery {
  limit: number;
  startingAfter: string | null;
}

export interface PageEnvelope<T> {
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePaginationQuery(query: { limit?: string; starting_after?: string }): PaginationQuery {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      throw new AppException({
        type: "invalid_request_error",
        code: "invalid_limit",
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
        param: "limit",
      });
    }
    limit = parsed;
  }

  return { limit, startingAfter: query.starting_after ?? null };
}

export function buildPageEnvelope<T extends { id: string }>(rows: T[], limit: number): PageEnvelope<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;
  return { data, has_more: hasMore, next_cursor: nextCursor };
}
