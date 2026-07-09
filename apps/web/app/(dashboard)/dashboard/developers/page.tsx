"use client";

import { useApiKeys } from "../../../../lib/hooks/useApiKeys.js";
import { useWebhookEndpoints } from "../../../../lib/hooks/useWebhookEndpoints.js";
import { useWebhookDeliveries } from "../../../../lib/hooks/useWebhookDeliveries.js";
import { ApiKeyManager } from "../../../../components/ApiKeyManager.js";
import { WebhookEndpointForm } from "../../../../components/WebhookEndpointForm.js";
import { StatusBadge } from "@cadence/ui";

export default function DevelopersPage() {
  const apiKeys = useApiKeys();
  const endpoints = useWebhookEndpoints();
  const deliveries = useWebhookDeliveries();

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Developers</h1>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">API keys</h2>
        {apiKeys.isLoading && <p className="font-body text-slate">Loading…</p>}
        {apiKeys.data && <ApiKeyManager apiKeys={apiKeys.data} createKey={apiKeys.createKey} revokeKey={apiKeys.revokeKey} />}
      </section>

      <section className="mb-8">
        <h2 className="font-display text-lg mb-3">Webhook endpoints</h2>
        <WebhookEndpointForm onSubmit={async (url) => { await endpoints.createEndpoint(url); }} />
        {endpoints.isLoading && <p className="font-body text-slate">Loading…</p>}
        <ul className="text-sm font-data">
          {endpoints.data?.map((ep) => (
            <li key={ep.id} className="flex items-center gap-2 py-1">
              <span>{ep.url}</span>
              <StatusBadge status={ep.status === "enabled" ? "active" : "canceled"} />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="font-display text-lg mb-3">Delivery log</h2>
        {deliveries.isLoading && <p className="font-body text-slate">Loading…</p>}
        <table className="w-full text-sm font-body">
          <thead>
            <tr className="text-left text-slate border-b border-slate/15">
              <th className="py-2">Event</th>
              <th className="py-2">Status</th>
              <th className="py-2">Attempts</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {deliveries.data?.map((d) => (
              <tr key={d.id} className="border-b border-slate/10">
                <td className="py-2 font-data">{d.eventType}</td>
                <td className="py-2"><StatusBadge status={d.status === "succeeded" ? "active" : d.status === "dead" ? "canceled" : "past_due"} /></td>
                <td className="py-2 font-data tabular-nums">{d.attempts}</td>
                <td className="py-2">
                  {(d.status === "failed" || d.status === "dead") && (
                    <button onClick={() => deliveries.replay(d.id)} className="text-sapphire text-xs">
                      Replay
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
