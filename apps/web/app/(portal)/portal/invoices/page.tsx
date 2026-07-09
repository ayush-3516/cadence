"use client";

import { useAccount } from "wagmi";
import { ConnectKitButton } from "connectkit";
import { usePortalInvoices } from "../../../../lib/hooks/usePortalInvoices.js";

export default function PortalInvoicesPage() {
  const { address, isConnected } = useAccount();
  const { data, isLoading, error } = usePortalInvoices(address);

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center mt-24 gap-4">
        <h1 className="font-display text-2xl">Invoices</h1>
        <p className="font-body text-slate">Connect your wallet to view your invoices.</p>
        <ConnectKitButton />
      </div>
    );
  }

  if (isLoading) return <p className="font-body text-slate">Loading…</p>;
  if (error) return <p className="font-body text-signal">Could not load invoices.</p>;

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">Invoices</h1>
      {data?.length === 0 && <p className="font-body text-slate">No invoices yet.</p>}
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-paper/15">
            <th className="py-2">Number</th>
            <th className="py-2">Date</th>
            <th className="py-2">Amount</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {data?.map((invoice) => (
            <tr key={invoice.id} className="border-b border-paper/10">
              <td className="py-2 font-data">{invoice.number}</td>
              <td className="py-2 font-data tabular-nums">{new Date(invoice.issued_at).toLocaleDateString()}</td>
              <td className="py-2 font-data tabular-nums">{invoice.amount}</td>
              <td className="py-2">
                {invoice.pdf_url ? (
                  <a href={invoice.pdf_url} target="_blank" rel="noreferrer" className="text-sapphire hover:underline text-xs">
                    Download
                  </a>
                ) : (
                  <span className="text-slate text-xs">Not available</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
