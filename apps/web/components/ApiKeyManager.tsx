"use client";

import { useState } from "react";
import type { ApiKey } from "../lib/hooks/useApiKeys.js";

export interface ApiKeyManagerProps {
  apiKeys: ApiKey[];
  createKey: (type: "secret" | "publishable") => Promise<{ id: string; key: string; prefix: string }>;
  revokeKey: (id: string) => Promise<void>;
}

export function ApiKeyManager({ apiKeys, createKey, revokeKey }: ApiKeyManagerProps) {
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  async function handleCreate(type: "secret" | "publishable") {
    const result = await createKey(type);
    setRevealedKey(result.key);
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => handleCreate("secret")} className="rounded-md bg-sapphire px-3 py-1.5 text-paper text-sm font-body">
          Create secret key
        </button>
        <button onClick={() => handleCreate("publishable")} className="rounded-md border border-sapphire px-3 py-1.5 text-sapphire text-sm font-body">
          Create publishable key
        </button>
      </div>
      {revealedKey && (
        <div className="mb-4 p-3 rounded-md bg-signal/10 border border-signal/30">
          <p className="text-xs font-body text-slate mb-1">Copy this key now — it won't be shown again.</p>
          <code className="font-data text-sm break-all">{revealedKey}</code>
        </div>
      )}
      <table className="w-full text-sm font-body">
        <thead>
          <tr className="text-left text-slate border-b border-slate/15">
            <th className="py-2">Key</th>
            <th className="py-2">Type</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {apiKeys.map((key) => (
            <tr key={key.id} className="border-b border-slate/10">
              <td className="py-2 font-data">{key.prefix}</td>
              <td className="py-2">{key.type}</td>
              <td className="py-2">
                <button onClick={() => revokeKey(key.id)} className="text-signal text-xs">
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
