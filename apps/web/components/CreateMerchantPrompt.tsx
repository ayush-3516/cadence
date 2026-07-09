"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { apiFetch } from "../lib/apiFetch.js";

export interface CreateMerchantPromptProps {
  onCreated: () => void;
}

export function CreateMerchantPrompt({ onCreated }: CreateMerchantPromptProps) {
  const { address } = useAccount();
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!address) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await apiFetch("/v1/merchants", { method: "POST", body: JSON.stringify({ name, ownerAddress: address }) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create merchant account.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-sm mx-auto mt-24 p-6 rounded-lg border border-slate/20">
      <h2 className="font-display text-lg mb-2">Set up your merchant account</h2>
      <p className="font-body text-slate text-sm mb-4">This is a one-time step to link your wallet to a Cadence merchant profile.</p>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Business name"
        required
        className="w-full rounded-md border border-slate/30 px-3 py-2 mb-3 font-body"
      />
      <button type="submit" disabled={isSubmitting || name.length === 0} className="w-full rounded-md bg-sapphire px-4 py-2 text-paper font-body">
        {isSubmitting ? "Creating…" : "Create account"}
      </button>
      {error && <p className="text-signal text-sm mt-2">{error}</p>}
    </form>
  );
}
