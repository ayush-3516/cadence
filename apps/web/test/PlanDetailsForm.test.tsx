import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PlanDetailsForm } from "../components/plans/PlanDetailsForm.js";

afterEach(() => {
  cleanup();
});

function fillBaseForm() {
  fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "20.00" } });
  fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: "0xdef000000000000000000000000000000000000b" } });
}

describe("PlanDetailsForm", () => {
  it("starts with a single recipient row pre-filled at 100%", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    const percentageInputs = screen.getAllByLabelText(/percentage/i);
    expect(percentageInputs).toHaveLength(1);
    expect((percentageInputs[0] as HTMLInputElement).value).toBe("100");
  });

  it("adds a new empty recipient row when 'Add recipient' is clicked", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }));
    expect(screen.getAllByLabelText(/percentage/i)).toHaveLength(2);
  });

  it("disables Continue when a single recipient's percentage is not 100", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fillBaseForm();
    fireEvent.change(screen.getAllByLabelText(/percentage/i)[0], { target: { value: "90" } });
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("disables Continue when two recipients' percentages do not sum to 100", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fillBaseForm();
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }));
    const percentageInputs = screen.getAllByLabelText(/percentage/i);
    fireEvent.change(percentageInputs[0], { target: { value: "60" } });
    fireEvent.change(percentageInputs[1], { target: { value: "30" } });
    const addressInputs = screen.getAllByLabelText(/^address/i);
    fireEvent.change(addressInputs[1], { target: { value: "0x999900000000000000000000000000000000000f" } });
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("enables Continue and calls onContinue with parsed values when two recipients sum to exactly 100", () => {
    const onContinue = vi.fn();
    render(<PlanDetailsForm onContinue={onContinue} />);
    fillBaseForm();
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }));
    const percentageInputs = screen.getAllByLabelText(/percentage/i);
    fireEvent.change(percentageInputs[0], { target: { value: "60" } });
    fireEvent.change(percentageInputs[1], { target: { value: "40" } });
    const addressInputs = screen.getAllByLabelText(/^address/i);
    fireEvent.change(addressInputs[1], { target: { value: "0x999900000000000000000000000000000000000f" } });

    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect(continueButton).toHaveProperty("disabled", false);
    fireEvent.click(continueButton);

    expect(onContinue).toHaveBeenCalledWith({
      amount: "20.00",
      periodSeconds: 2592000,
      trialSeconds: 0,
      recipients: [
        { address: "0xdef000000000000000000000000000000000000b", percentage: "60" },
        { address: "0x999900000000000000000000000000000000000f", percentage: "40" },
      ],
    });
  });

  it("disables Continue when a recipient address is malformed", () => {
    render(<PlanDetailsForm onContinue={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "20.00" } });
    fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: "not-an-address" } });
    expect(screen.getByRole("button", { name: /continue/i })).toHaveProperty("disabled", true);
  });

  it("defaults period to Monthly and trial to None", () => {
    const onContinue = vi.fn();
    render(<PlanDetailsForm onContinue={onContinue} />);
    fillBaseForm();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ periodSeconds: 2592000, trialSeconds: 0 }));
  });
});
