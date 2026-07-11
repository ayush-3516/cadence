import { describe, expect, it } from "vitest";
import { erc20PermitAbi } from "../abis/Erc20Permit.js";

describe("erc20PermitAbi", () => {
  it("includes name, nonces, and permit function fragments", () => {
    const functionNames = erc20PermitAbi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name);

    expect(functionNames).toContain("name");
    expect(functionNames).toContain("nonces");
    expect(functionNames).toContain("permit");
  });

  it("defines nonces as taking one address input and returning one uint256", () => {
    const nonces = erc20PermitAbi.find((entry) => entry.type === "function" && entry.name === "nonces");
    expect(nonces).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(nonces.inputs).toEqual([{ name: "owner", type: "address", internalType: "address" }]);
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(nonces.outputs).toEqual([{ name: "", type: "uint256", internalType: "uint256" }]);
  });

  it("includes a standard ERC-20 approve function fragment", () => {
    const approveFn = erc20PermitAbi.find((entry) => entry.type === "function" && entry.name === "approve");
    expect(approveFn).toBeDefined();
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(approveFn.inputs).toEqual([
      { name: "spender", type: "address", internalType: "address" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ]);
    // @ts-expect-error -- narrowed by the find() above at runtime
    expect(approveFn.outputs).toEqual([{ name: "", type: "bool", internalType: "bool" }]);
  });
});
