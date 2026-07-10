import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlanReviewSubmit } from "../components/plans/PlanReviewSubmit.js";
import type { PlanDetailsFormValues } from "../components/plans/PlanDetailsForm.js";

const mockUseCreatePlanSubmit = vi.fn();

vi.mock("../lib/hooks/useCreatePlanSubmit.js", () => ({
  useCreatePlanSubmit: () => mockUseCreatePlanSubmit(),
}));

const VALUES: PlanDetailsFormValues = {
  amount: "20.00",
  periodSeconds: 2592000,
  trialSeconds: 0,
  recipients: [{ address: "0xdef000000000000000000000000000000000000b", percentage: "100" }],
};

describe("PlanReviewSubmit", () => {
  beforeEach(() => {
    mockUseCreatePlanSubmit.mockReset();
    mockUseCreatePlanSubmit.mockReturnValue({ status: "idle", error: null, submit: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a read-only summary of the plan values", () => {
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/20\.00/)).toBeDefined();
    expect(screen.getByText(/0xdef000000000000000000000000000000000000b/i)).toBeDefined();
    expect(screen.getByText(/100/)).toBeDefined();
  });

  it("calls submit with the values when Create Plan is clicked", () => {
    const submit = vi.fn();
    mockUseCreatePlanSubmit.mockReturnValue({ status: "idle", error: null, submit });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /create plan/i }));
    expect(submit).toHaveBeenCalledWith(VALUES);
  });

  it("shows a deploying-split status message and disables the button while deploying", () => {
    mockUseCreatePlanSubmit.mockReturnValue({ status: "deploying-split", error: null, submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/deploying split/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /create plan/i })).toHaveProperty("disabled", true);
  });

  it("shows a confirming-plan status message", () => {
    mockUseCreatePlanSubmit.mockReturnValue({ status: "confirming-plan", error: null, submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/confirm in your wallet/i)).toBeDefined();
  });

  it("shows the error message and a retry button on error", () => {
    mockUseCreatePlanSubmit.mockReturnValue({ status: "error", error: new Error("boom"), submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={vi.fn()} />);
    expect(screen.getByText(/boom/)).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });

  it("calls onDone once when status is done", () => {
    const onDone = vi.fn();
    mockUseCreatePlanSubmit.mockReturnValue({ status: "done", error: null, submit: vi.fn() });
    render(<PlanReviewSubmit values={VALUES} onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
