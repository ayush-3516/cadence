"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";
import { apiFetch } from "../lib/apiFetch.js";
import { ConnectKitButton } from "connectkit";

export interface SignInButtonProps {
  onSignedIn: (address: string) => void;
}

export function SignInButton({ onSignedIn }: SignInButtonProps) {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isConnected || !address) {
    return <ConnectKitButton />;
  }

  async function handleSignIn() {
    setIsSigningIn(true);
    setError(null);
    try {
      const { nonce } = (await apiFetch("/v1/auth/nonce", { method: "POST" })) as { nonce: string };

      const siweMessage = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Cadence.",
        uri: window.location.origin,
        version: "1",
        chainId: chainId ?? 84532,
        nonce,
      });
      const messageToSign = siweMessage.prepareMessage();
      const signature = await signMessageAsync({ message: messageToSign });

      const { address: verifiedAddress } = (await apiFetch("/v1/auth/verify", {
        method: "POST",
        body: JSON.stringify({ message: messageToSign, signature }),
      })) as { address: string };

      onSignedIn(verifiedAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setIsSigningIn(false);
    }
  }

  return (
    <div>
      <button onClick={handleSignIn} disabled={isSigningIn} className="rounded-md bg-sapphire px-4 py-2 text-paper font-body">
        {isSigningIn ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="text-signal text-sm mt-2">{error}</p>}
    </div>
  );
}
