"use client";

import { useState } from "react";

export interface PlanRecipientInput {
  address: string;
  percentage: string;
}

export interface PlanDetailsFormValues {
  amount: string;
  periodSeconds: number;
  trialSeconds: number;
  recipients: PlanRecipientInput[];
}

export interface PlanDetailsFormProps {
  onContinue: (values: PlanDetailsFormValues) => void;
}

const PERIOD_OPTIONS = [
  { label: "Weekly", seconds: 604800 },
  { label: "Monthly", seconds: 2592000 },
  { label: "Yearly", seconds: 31536000 },
];

const TRIAL_OPTIONS = [
  { label: "None", seconds: 0 },
  { label: "7 days", seconds: 604800 },
  { label: "14 days", seconds: 1209600 },
  { label: "30 days", seconds: 2592000 },
];

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

function isValidAmount(amount: string): boolean {
  const parsed = Number(amount);
  return amount.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;
}

function isValid(amount: string, recipients: PlanRecipientInput[]): boolean {
  if (!isValidAmount(amount)) return false;
  if (recipients.length === 0) return false;

  let sum = 0;
  for (const recipient of recipients) {
    if (!ADDRESS_PATTERN.test(recipient.address)) return false;
    const pct = Number(recipient.percentage);
    if (!Number.isFinite(pct) || pct <= 0) return false;
    sum += pct;
  }
  // Floating point tolerance: percentages are decimal strings from user input.
  return Math.abs(sum - 100) < 0.0001;
}

export function PlanDetailsForm({ onContinue }: PlanDetailsFormProps) {
  const [amount, setAmount] = useState("");
  const [periodSeconds, setPeriodSeconds] = useState(PERIOD_OPTIONS[1].seconds);
  const [trialSeconds, setTrialSeconds] = useState(TRIAL_OPTIONS[0].seconds);
  const [recipients, setRecipients] = useState<PlanRecipientInput[]>([{ address: "", percentage: "100" }]);

  function updateRecipient(index: number, field: keyof PlanRecipientInput, value: string) {
    setRecipients((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  }

  function addRecipient() {
    setRecipients((prev) => [...prev, { address: "", percentage: "" }]);
  }

  const valid = isValid(amount, recipients);

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div>
        <label htmlFor="plan-amount" className="block font-body text-sm mb-1">
          Amount (USDC)
        </label>
        <input
          id="plan-amount"
          type="text"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-md border border-slate/25 px-3 py-2 font-data"
        />
      </div>

      <div>
        <label htmlFor="plan-period" className="block font-body text-sm mb-1">
          Billing period
        </label>
        <select
          id="plan-period"
          value={periodSeconds}
          onChange={(e) => setPeriodSeconds(Number(e.target.value))}
          className="w-full rounded-md border border-slate/25 px-3 py-2"
        >
          {PERIOD_OPTIONS.map((opt) => (
            <option key={opt.seconds} value={opt.seconds}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="plan-trial" className="block font-body text-sm mb-1">
          Trial period
        </label>
        <select
          id="plan-trial"
          value={trialSeconds}
          onChange={(e) => setTrialSeconds(Number(e.target.value))}
          className="w-full rounded-md border border-slate/25 px-3 py-2"
        >
          {TRIAL_OPTIONS.map((opt) => (
            <option key={opt.seconds} value={opt.seconds}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-3">
        <span className="font-body text-sm">Recipients</span>
        {recipients.map((recipient, index) => (
          <div key={index} className="flex gap-3">
            <div className="flex-1">
              <label htmlFor={`recipient-address-${index}`} className="sr-only">
                Address {index + 1}
              </label>
              <input
                id={`recipient-address-${index}`}
                type="text"
                placeholder="0x..."
                value={recipient.address}
                onChange={(e) => updateRecipient(index, "address", e.target.value)}
                className="w-full rounded-md border border-slate/25 px-3 py-2 font-data"
              />
            </div>
            <div className="w-28">
              <label htmlFor={`recipient-percentage-${index}`} className="sr-only">
                Percentage {index + 1}
              </label>
              <input
                id={`recipient-percentage-${index}`}
                type="text"
                value={recipient.percentage}
                onChange={(e) => updateRecipient(index, "percentage", e.target.value)}
                className="w-full rounded-md border border-slate/25 px-3 py-2 font-data"
              />
            </div>
          </div>
        ))}
        <button type="button" onClick={addRecipient} className="self-start rounded-md border border-slate/25 px-3 py-1.5 text-sm font-body">
          Add recipient
        </button>
      </div>

      <button
        type="button"
        disabled={!valid}
        onClick={() => onContinue({ amount, periodSeconds, trialSeconds, recipients })}
        className="self-start rounded-md bg-sapphire text-paper px-5 py-2.5 font-body font-semibold disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
