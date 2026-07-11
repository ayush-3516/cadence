import { Inject, Injectable } from "@nestjs/common";
import { encodeFunctionData, type PublicClient } from "viem";
import { subscriptionManagerAbi, erc20PermitAbi } from "@cadence/shared";
import { loadPrepareConfig } from "../config/prepare-config.js";
import { PREPARE_RPC_CLIENT } from "./rpc-client.module.js";
import { PlansService } from "../plans/plans.service.js";
import type { PreparePlanQuery, PrepareSubscribeQuery } from "./prepare.dto.js";

export interface PreparePlanResponse {
  to: string;
  data: string;
  value: "0";
}

export interface PrepareSubscribeResponse {
  permit: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    types: { Permit: { name: string; type: string }[] };
    message: { owner: string; spender: string; value: string; nonce: string; deadline: string };
  };
  subscribe: { to: string; fn: "subscribeWithPermit"; planId: string; deadline: string };
}

const PERMIT_DEADLINE_SECONDS = 15 * 60;
// SubscriptionManager._charge() draws down a standing ERC-20 allowance every
// billing period (no fresh permit per charge) — a permit sized to exactly one
// period's amount means every subscription self-terminates into past_due
// after its first charge. 12 periods gives a full year of unattended
// auto-renewal for monthly plans while bounding the subscriber's real
// exposure to an auditable, fixed number rather than an unlimited allowance.
const PERMIT_PERIODS_ALLOWANCE = 12;

const VERSION_ABI = [
  { type: "function", name: "version", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
] as const;

@Injectable()
export class PrepareService {
  constructor(
    @Inject(PREPARE_RPC_CLIENT) private readonly publicClient: PublicClient,
    private readonly plansService: PlansService,
  ) {}

  buildCreatePlanCalldata(params: PreparePlanQuery): PreparePlanResponse {
    const config = loadPrepareConfig();

    const data = encodeFunctionData({
      abi: subscriptionManagerAbi,
      functionName: "createPlan",
      args: [
        params.payoutSplit as `0x${string}`,
        params.token as `0x${string}`,
        BigInt(params.amount),
        Number(params.period),
        Number(params.trial),
      ],
    });

    return { to: config.subscriptionManagerAddress, data, value: "0" };
  }

  async buildSubscribePermit(callerOwnerAddress: string, params: PrepareSubscribeQuery): Promise<PrepareSubscribeResponse> {
    const config = loadPrepareConfig();
    const plan = await this.plansService.getByOnchainId(callerOwnerAddress, params.planId);

    const tokenAddress = plan.token as `0x${string}`;
    const owner = params.owner as `0x${string}`;

    const [name, nonce] = await Promise.all([
      this.publicClient.readContract({ address: tokenAddress, abi: erc20PermitAbi, functionName: "name" }),
      this.publicClient.readContract({ address: tokenAddress, abi: erc20PermitAbi, functionName: "nonces", args: [owner] }),
    ]);

    let version = "1";
    try {
      version = await this.publicClient.readContract({ address: tokenAddress, abi: VERSION_ABI, functionName: "version" });
    } catch {
      // Not every ERC-20 exposes version() (EIP-5267 is not universal) — "1" is
      // the EIP-2612 reference implementation's default and a safe fallback.
    }

    const deadline = String(Math.floor(Date.now() / 1000) + PERMIT_DEADLINE_SECONDS);

    return {
      permit: {
        domain: { name, version, chainId: config.chainId, verifyingContract: tokenAddress },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        message: {
          owner,
          spender: config.subscriptionManagerAddress,
          value: (BigInt(plan.amount) * BigInt(PERMIT_PERIODS_ALLOWANCE)).toString(),
          nonce: nonce.toString(),
          deadline,
        },
      },
      subscribe: {
        to: config.subscriptionManagerAddress,
        fn: "subscribeWithPermit",
        planId: params.planId,
        deadline,
      },
    };
  }
}
