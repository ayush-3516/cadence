import { Injectable } from "@nestjs/common";
import { encodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@cadence/shared";
import { loadPrepareConfig } from "../config/prepare-config.js";
import type { PreparePlanQuery } from "./prepare.dto.js";

export interface PreparePlanResponse {
  to: string;
  data: string;
  value: "0";
}

@Injectable()
export class PrepareService {
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
}
