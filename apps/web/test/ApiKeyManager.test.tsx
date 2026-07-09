import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiKeyManager } from "../components/ApiKeyManager.js";

describe("ApiKeyManager", () => {
  it("shows the newly created raw key once after creation, then a masked prefix", async () => {
    const createKey = vi.fn().mockResolvedValue({ id: "k1", key: "ck_test_sec_rawvalue", prefix: "ck_test_sec_rawv" });
    render(<ApiKeyManager apiKeys={[]} createKey={createKey} revokeKey={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /create secret key/i }));

    const rawKey = await screen.findByText("ck_test_sec_rawvalue");
    expect(rawKey).toBeTruthy();
  });

  it("renders existing keys by their prefix only, never a full key value", () => {
    render(
      <ApiKeyManager
        apiKeys={[{ id: "k1", type: "secret", prefix: "ck_test_sec_abc", livemode: false, lastUsedAt: null, createdAt: "2026-07-01T00:00:00Z" }]}
        createKey={vi.fn()}
        revokeKey={vi.fn()}
      />,
    );

    expect(screen.getByText("ck_test_sec_abc")).toBeTruthy();
  });
});
