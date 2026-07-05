import { describe, expect, it } from "vitest";
import { parsePaginationQuery, buildPageEnvelope } from "../src/common/pagination.js";
import { AppException } from "../src/common/errors.js";

describe("parsePaginationQuery", () => {
  it("defaults to limit 20 and no cursor", () => {
    expect(parsePaginationQuery({})).toEqual({ limit: 20, startingAfter: null });
  });

  it("parses a valid limit and cursor", () => {
    expect(parsePaginationQuery({ limit: "5", starting_after: "42" })).toEqual({ limit: 5, startingAfter: "42" });
  });

  it("rejects a limit above 100", () => {
    expect(() => parsePaginationQuery({ limit: "101" })).toThrow(AppException);
  });

  it("rejects a limit below 1", () => {
    expect(() => parsePaginationQuery({ limit: "0" })).toThrow(AppException);
  });

  it("rejects a non-numeric limit", () => {
    expect(() => parsePaginationQuery({ limit: "abc" })).toThrow(AppException);
  });
});

describe("buildPageEnvelope", () => {
  it("reports has_more=false and next_cursor=null when fewer rows than limit+1 exist", () => {
    const rows = [{ id: "1" }, { id: "2" }];
    expect(buildPageEnvelope(rows, 20)).toEqual({ data: rows, has_more: false, next_cursor: null });
  });

  it("reports has_more=true and slices off the probe row when limit+1 rows exist", () => {
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(buildPageEnvelope(rows, 2)).toEqual({
      data: [{ id: "1" }, { id: "2" }],
      has_more: true,
      next_cursor: "2",
    });
  });
});
