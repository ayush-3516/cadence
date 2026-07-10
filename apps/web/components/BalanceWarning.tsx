export interface BalanceWarningProps {
  balance: bigint | undefined;
  required: string;
}

export function BalanceWarning({ balance, required }: BalanceWarningProps) {
  if (balance === undefined) return null;
  if (balance >= BigInt(required)) return null;

  return (
    <p className="text-signal text-xs font-body mt-1">Insufficient USDC balance for the next charge.</p>
  );
}
