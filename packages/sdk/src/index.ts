// `verifySignature` (node:crypto-based HMAC verification) is deliberately NOT re-exported
// here — it's Node-only and would pull `node:crypto` into any browser bundle importing
// anything from this barrel (confirmed: webpack fails to resolve it client-side). Import it
// from the dedicated subpath instead: `import { verifySignature } from "@cadence/sdk/webhooks"`.
export { Cadence, type CadenceConfig } from "./client.js";
export { CadenceError, type CadenceErrorType } from "./errors.js";
export type {
  PageEnvelope,
  Plan,
  ChargeSummary,
  PlanSummary,
  Subscription,
  SubscriptionDetail,
  Customer,
  Invoice,
  AnalyticsSummary,
  MrrPoint,
  CohortOffset,
  CohortRow,
  WebhookEndpoint,
  WebhookDelivery,
  Merchant,
} from "./types.js";
export type { ListPlansFilter, AttachPlanMetadataBody } from "./resources/plans.js";
export type { ListSubscriptionsFilter } from "./resources/subscriptions.js";
export type { ListCustomersFilter } from "./resources/customers.js";
export type { ListInvoicesFilter } from "./resources/invoices.js";
export type { AnalyticsRange } from "./resources/analytics.js";
export type { CreateWebhookEndpointBody, UpdateWebhookEndpointBody, ListWebhookEndpointsFilter } from "./resources/webhook-endpoints.js";
export type { ListWebhookDeliveriesFilter } from "./resources/webhook-deliveries.js";
