const TICK_COUNT = 8;

export interface CadencePulseProps {
  periodSeconds: number;
  currentPeriodEnd: string;
  /** Injectable for deterministic testing; defaults to the real current time. */
  now?: Date;
}

export function CadencePulse({ periodSeconds, currentPeriodEnd, now = new Date() }: CadencePulseProps) {
  const periodEnd = new Date(currentPeriodEnd);
  const periodStart = new Date(periodEnd.getTime() - periodSeconds * 1000);
  const elapsedMs = now.getTime() - periodStart.getTime();
  const elapsedFraction = Math.min(1, Math.max(0, elapsedMs / (periodSeconds * 1000)));

  const activeIndex = Math.round(elapsedFraction * (TICK_COUNT - 1));
  const nextIndex = TICK_COUNT - 1;

  return (
    <div className="flex items-center gap-1" role="img" aria-label="billing cadence">
      {Array.from({ length: TICK_COUNT }, (_, i) => {
        const state = i === activeIndex ? "active" : i === nextIndex ? "next" : "idle";
        const color = state === "active" ? "bg-sapphire" : state === "next" ? "bg-signal" : "bg-slate/25";
        const height = state === "idle" ? "h-2" : state === "next" ? "h-4.5" : "h-6";
        return <div key={i} data-tick={i} data-tick-state={state} className={`flex-1 rounded-sm ${color} ${height}`} />;
      })}
    </div>
  );
}
