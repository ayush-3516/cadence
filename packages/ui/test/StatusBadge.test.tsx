import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../src/StatusBadge.js";

describe("StatusBadge", () => {
  it("renders active status in mint", () => {
    render(<StatusBadge status="active" />);
    const badge = screen.getByText("active");
    expect(badge.className).toContain("mint");
  });

  it("renders trialing status in mint", () => {
    render(<StatusBadge status="trialing" />);
    expect(screen.getByText("trialing").className).toContain("mint");
  });

  it("renders past_due status in signal", () => {
    render(<StatusBadge status="past_due" />);
    expect(screen.getByText("past_due").className).toContain("signal");
  });

  it("renders paused status in signal", () => {
    render(<StatusBadge status="paused" />);
    expect(screen.getByText("paused").className).toContain("signal");
  });

  it("renders canceled status in slate", () => {
    render(<StatusBadge status="canceled" />);
    expect(screen.getByText("canceled").className).toContain("slate");
  });

  it("renders an unrecognized status in slate as a safe default", () => {
    render(<StatusBadge status="some_future_status" />);
    expect(screen.getByText("some_future_status").className).toContain("slate");
  });
});
