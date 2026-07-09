"use client";

import { useEffect, useState } from "react";
import { SignInButton } from "../../components/SignInButton.js";
import { CreateMerchantPrompt } from "../../components/CreateMerchantPrompt.js";
import { DashboardNav } from "../../components/DashboardNav.js";
import { apiFetch, ApiError } from "../../lib/apiFetch.js";

type AuthState = "checking" | "signed-out" | "no-merchant" | "ready";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>("checking");

  async function checkMerchant() {
    try {
      await apiFetch("/v1/merchants/me");
      setAuthState("ready");
    } catch (err) {
      if (err instanceof ApiError && err.code === "merchant_not_found") {
        setAuthState("no-merchant");
      } else {
        setAuthState("signed-out");
      }
    }
  }

  useEffect(() => {
    checkMerchant();
  }, []);

  if (authState === "checking") {
    return <div className="p-8 font-body text-slate">Loading…</div>;
  }

  if (authState === "signed-out") {
    return (
      <div className="flex flex-col items-center mt-24 gap-4">
        <h1 className="font-display text-2xl">Sign in to Cadence</h1>
        <SignInButton onSignedIn={() => checkMerchant()} />
      </div>
    );
  }

  if (authState === "no-merchant") {
    return <CreateMerchantPrompt onCreated={() => checkMerchant()} />;
  }

  return (
    <div className="flex min-h-screen">
      <DashboardNav />
      <div className="flex-1 p-8">{children}</div>
    </div>
  );
}
