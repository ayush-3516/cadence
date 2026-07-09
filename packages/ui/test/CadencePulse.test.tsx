import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CadencePulse } from "../src/CadencePulse.js";

describe("CadencePulse", () => {
  it("renders 8 ticks for a subscription mid-period", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400; // 30-day period
    const currentPeriodEnd = new Date(now.getTime() + 15 * 86400 * 1000).toISOString(); // 15 days remaining, so ~50% elapsed

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const ticks = container.querySelectorAll("[data-tick]");
    expect(ticks.length).toBe(8);
  });

  it("marks a tick near the midpoint as active when the period is ~50% elapsed", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400;
    const currentPeriodEnd = new Date(now.getTime() + 15 * 86400 * 1000).toISOString();

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const activeTick = container.querySelector('[data-tick-state="active"]');
    expect(activeTick).not.toBeNull();
    const activeIndex = Number(activeTick?.getAttribute("data-tick"));
    // With 8 ticks and ~50% elapsed, the active tick should land roughly in the middle (index 3 or 4).
    expect(activeIndex).toBeGreaterThanOrEqual(2);
    expect(activeIndex).toBeLessThanOrEqual(5);
  });

  it("marks the last tick as the next-charge tick", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400;
    const currentPeriodEnd = new Date(now.getTime() + 15 * 86400 * 1000).toISOString();

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const nextTick = container.querySelector('[data-tick-state="next"]');
    expect(nextTick?.getAttribute("data-tick")).toBe("7");
  });

  it("marks the active tick at index 0 when the period just started", () => {
    const now = new Date("2026-07-08T00:00:00Z");
    const periodSeconds = 30 * 86400;
    const currentPeriodEnd = new Date(now.getTime() + 30 * 86400 * 1000).toISOString(); // full period remaining, 0% elapsed

    const { container } = render(<CadencePulse periodSeconds={periodSeconds} currentPeriodEnd={currentPeriodEnd} now={now} />);
    const activeTick = container.querySelector('[data-tick-state="active"]');
    expect(activeTick?.getAttribute("data-tick")).toBe("0");
  });
});
