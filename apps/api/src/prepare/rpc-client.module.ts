import { Global, Module } from "@nestjs/common";
import { createPublicClient, http, type PublicClient } from "viem";
import { loadPrepareConfig } from "../config/prepare-config.js";

export const PREPARE_RPC_CLIENT = Symbol("PREPARE_RPC_CLIENT");

// Global + a dedicated Symbol token (mirrors DB_CLIENT in ../db/db.module.ts)
// so PrepareService's tests can inject a fake PublicClient via
// overrideProvider(PREPARE_RPC_CLIENT) instead of hitting a live RPC endpoint.
@Global()
@Module({
  providers: [
    {
      provide: PREPARE_RPC_CLIENT,
      useFactory: (): PublicClient => {
        const config = loadPrepareConfig();
        return createPublicClient({ transport: http(config.rpcUrlHttp) });
      },
    },
  ],
  exports: [PREPARE_RPC_CLIENT],
})
export class RpcClientModule {}
