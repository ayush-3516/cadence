import { Module } from "@nestjs/common";
import { createPublicClient, http, type PublicClient } from "viem";

export const PREPARE_RPC_CLIENT = Symbol("PREPARE_RPC_CLIENT");

// PrepareModule (not @Global — this client is only needed there) imports this
// module directly, so PREPARE_RPC_CLIENT is only visible to Prepare's own
// controller/service, mirroring DB_CLIENT's Symbol-token + useFactory shape
// in ../db/db.module.ts without DB_CLIENT's @Global (every module needs the
// DB; only Prepare needs an RPC client).
//
// This factory reads RPC_URL_HTTP directly from process.env, NOT via
// loadPrepareConfig() (../config/prepare-config.ts) — loadPrepareConfig also
// requires CHAIN_ID and reads the deployments/<chainId>.json file, and Nest
// instantiates every provider of every imported module at bootstrap
// regardless of @Global. AppModule always imports PrepareModule, so an
// eager loadPrepareConfig() call in this factory would throw "Missing
// required environment variable: CHAIN_ID" on every test/process that boots
// the full AppModule without setting it — i.e. every other e2e spec in this
// codebase. viem's http() transport performs no network I/O at construction
// time but DOES validate eagerly that a syntactically valid URL was given
// (an empty string throws UrlRequiredError), so an unset RPC_URL_HTTP falls
// back to a placeholder localhost URL that is never actually dialed unless
// /v1/prepare/subscribe is really invoked without the env var set — which
// only happens in dev/test environments that don't exercise that route.
// PrepareService still calls loadPrepareConfig() itself for
// chainId/subscriptionManagerAddress when a request actually arrives, so a
// misconfigured production deployment still fails loudly on the first real
// request rather than silently.
const UNSET_RPC_URL_PLACEHOLDER = "http://127.0.0.1:0";

@Module({
  providers: [
    {
      provide: PREPARE_RPC_CLIENT,
      useFactory: (): PublicClient =>
        createPublicClient({ transport: http(process.env.RPC_URL_HTTP || UNSET_RPC_URL_PLACEHOLDER) }),
    },
  ],
  exports: [PREPARE_RPC_CLIENT],
})
export class RpcClientModule {}
