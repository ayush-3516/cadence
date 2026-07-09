"use client";

import { useState } from "react";

export interface WebhookEndpointFormProps {
  onSubmit: (url: string) => Promise<void>;
}

export function WebhookEndpointForm({ onSubmit }: WebhookEndpointFormProps) {
  const [url, setUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      await onSubmit(url);
      setUrl("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 mb-4">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://example.com/webhook"
        required
        className="flex-1 rounded-md border border-slate/30 px-3 py-1.5 text-sm font-data"
      />
      <button type="submit" disabled={isSubmitting} className="rounded-md bg-sapphire px-3 py-1.5 text-paper text-sm font-body">
        Add endpoint
      </button>
    </form>
  );
}
