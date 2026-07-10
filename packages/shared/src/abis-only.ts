// Browser-safe subset of @cadence/shared's exports — ABIs only, no node:crypto.
// The main barrel (index.ts) also exports encryptSecret/decryptSecret from
// webhook-crypto.ts, which imports node:crypto; any bundler building for a browser
// target that imports anything from the main barrel transitively pulls that in and
// fails (confirmed: webpack's UnhandledSchemeError for "node:crypto" when apps/web
// imported subscriptionManagerAbi via the main barrel). Browser consumers needing
// only the ABIs should import from this subpath (@cadence/shared/abis) instead.
export { subscriptionManagerAbi } from "../abis/SubscriptionManager.js";
export { feeRegistryAbi } from "../abis/FeeRegistry.js";
export { erc20PermitAbi } from "../abis/Erc20Permit.js";
