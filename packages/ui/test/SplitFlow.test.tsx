import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SplitFlow } from "../src/SplitFlow.js";

const RECIPIENTS = [
  { amount: "14.44", label: "founder.eth" },
  { amount: "4.81", label: "agency.eth" },
];

describe("SplitFlow", () => {
  it("renders the source amount, fee amount/label, and every recipient's amount/label", () => {
    render(<SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} />);

    expect(screen.getByText(/20\.00/)).toBeDefined();
    expect(screen.getByText(/0\.75/)).toBeDefined();
    expect(screen.getByText("platform")).toBeDefined();
    expect(screen.getByText(/14\.44/)).toBeDefined();
    expect(screen.getByText("founder.eth")).toBeDefined();
    expect(screen.getByText(/4\.81/)).toBeDefined();
    expect(screen.getByText("agency.eth")).toBeDefined();
  });

  it("renders one SVG path per recipient plus one for the fee", () => {
    const { container } = render(<SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} />);

    const paths = container.querySelectorAll("svg path[data-split-path]");
    // 1 fee path + 2 recipient paths = 3
    expect(paths.length).toBe(3);
  });

  it("assigns each recipient a distinct color class, cycling through the palette", () => {
    const { container } = render(<SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} />);

    const recipientChips = container.querySelectorAll("[data-split-chip='recipient']");
    expect(recipientChips.length).toBe(2);
    const firstClasses = recipientChips[0].className;
    const secondClasses = recipientChips[1].className;
    expect(firstClasses).not.toBe(secondClasses);
  });

  it("marks the animation as disabled when prefers-reduced-motion is set", () => {
    const { container } = render(
      <SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} reducedMotion={true} />,
    );

    const pulses = container.querySelectorAll("[data-split-pulse]");
    pulses.forEach((pulse) => {
      expect((pulse as HTMLElement).style.animation).toBe("none");
    });
  });

  it("does not disable the animation when reducedMotion is false", () => {
    const { container } = render(
      <SplitFlow amount="20.00" feeAmount="0.75" feeLabel="platform" recipients={RECIPIENTS} reducedMotion={false} />,
    );

    const pulses = container.querySelectorAll("[data-split-pulse]");
    pulses.forEach((pulse) => {
      expect((pulse as HTMLElement).style.animation).not.toBe("none");
    });
  });
});
