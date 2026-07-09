import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BalanceWarning } from "../components/BalanceWarning.js";

describe("BalanceWarning", () => {
  it("renders a warning when balance is below the required amount", () => {
    render(<BalanceWarning balance={5_000_000n} required="20000000" />);
    expect(screen.getByText(/insufficient/i)).toBeTruthy();
  });

  it("renders nothing when balance covers the required amount", () => {
    const { container } = render(<BalanceWarning balance={50_000_000n} required="20000000" />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing while balance is still loading (undefined)", () => {
    const { container } = render(<BalanceWarning balance={undefined} required="20000000" />);
    expect(container.textContent).toBe("");
  });
});
