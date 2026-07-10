// Full class strings in a lookup array, not interpolated fragments — Tailwind's
// static analyzer only extracts whole utility-class literals from source, so a
// template literal like `text-${color}` never emits any CSS for the class it
// builds. Matches the exact pattern StatusBadge.tsx already established (and the
// bug the Phase 1k whole-branch review found and fixed when this rule was
// violated). Cycles through this list if there are ever more recipients than
// colors defined here.
//
// The second entry omits `text`/`border`: `text-sapphire-200`/`border-sapphire-200`
// are not real Tailwind classes in this codebase — apps/web/app/globals.css's
// `@theme` block only defines a single `--color-sapphire` shade, no shade-scale
// variant. When `text`/`border` are falsy, the chip-rendering code below falls
// back to inline `style` with the raw hex `stroke` value instead.
const RECIPIENT_PALETTE = [
  { text: "text-mint", border: "border-mint/35", stroke: "#17B890", glow: "rgba(23,184,144,0.85)" },
  { text: null, border: null, stroke: "#6fb3ff", glow: "rgba(111,179,255,0.85)" },
];

export interface SplitFlowRecipient {
  amount: string;
  label: string;
}

export interface SplitFlowProps {
  /** The total amount charged, rendered at the source node. Formatted string, e.g. "20.00" — no currency symbol prefix is added by this component. */
  amount: string;
  /** The platform fee amount, rendered at the fee node. */
  feeAmount: string;
  /** Label under the fee chip, e.g. "platform". */
  feeLabel: string;
  /** One or more payout recipients. Each gets a distinct color from RECIPIENT_PALETTE, cycling if there are more recipients than palette entries. */
  recipients: SplitFlowRecipient[];
  /** Explicit override for prefers-reduced-motion — see the note in SplitFlow.test.tsx for why this isn't auto-detected inside the component. Defaults to false (animate). */
  reducedMotion?: boolean;
}

function verticalPercent(index: number, total: number): number {
  if (total === 1) return 50;
  const span = 88; // leaves 6% margin top and bottom, matching the validated hero mockup's spacing
  return 6 + (span * index) / (total - 1);
}

export function SplitFlow({ amount, feeAmount, feeLabel, recipients, reducedMotion = false }: SplitFlowProps) {
  // Fee is always the first "right-side" node; recipients follow it, all sharing
  // the same vertical distribution logic (fee counts as one of the slots).
  const allRightNodes = [{ amount: feeAmount, label: feeLabel, kind: "fee" as const }, ...recipients.map((r) => ({ ...r, kind: "recipient" as const }))];
  const total = allRightNodes.length;

  return (
    <div className="relative rounded-2xl border border-paper/10 bg-ink p-6 sm:p-8" data-testid="split-flow">
      <style>{`
        @keyframes split-flow-travel {
          0%   { offset-distance: 0%;   opacity: 0; }
          8%   { opacity: 1; }
          92%  { opacity: 1; }
          100% { offset-distance: 100%; opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-split-pulse] { animation: none !important; }
        }
      `}</style>
      <div className="relative" style={{ height: "clamp(200px, 26vw, 240px)" }}>
        <div className="absolute flex flex-col items-start gap-1.5" style={{ left: 0, top: "50%", transform: "translateY(-50%)" }}>
          <span className="font-data tabular-nums text-sm sm:text-base font-medium text-paper border border-paper/25 rounded-lg px-3.5 py-2 whitespace-nowrap" data-split-chip="source">
            {amount} charged
          </span>
        </div>

        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {allRightNodes.map((node, i) => {
            const y = verticalPercent(i, total);
            const color = node.kind === "fee" ? "#F4A62A" : RECIPIENT_PALETTE[(i - 1) % RECIPIENT_PALETTE.length].stroke;
            const glow = node.kind === "fee" ? "rgba(244,166,42,0.85)" : RECIPIENT_PALETTE[(i - 1) % RECIPIENT_PALETTE.length].glow;
            const path = `M 24 50 C 55 50 55 ${y} 76 ${y}`;
            return (
              <g key={i}>
                <path data-split-path d={path} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <circle
                  data-split-pulse
                  r={1.4}
                  fill={color}
                  style={{
                    filter: `drop-shadow(0 0 5px ${glow})`,
                    offsetPath: `path('${path}')`,
                    animation: reducedMotion ? "none" : `split-flow-travel 2.8s ease-in-out infinite`,
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              </g>
            );
          })}
        </svg>

        {allRightNodes.map((node, i) => {
          const y = verticalPercent(i, total);
          const palette = node.kind === "fee" ? { text: "text-signal", border: "border-signal/35", stroke: null } : RECIPIENT_PALETTE[(i - 1) % RECIPIENT_PALETTE.length];
          const chipClassName = `font-data tabular-nums text-sm sm:text-base font-medium ${palette.text ?? ""} border ${palette.border ?? ""} rounded-lg px-3.5 py-2 whitespace-nowrap bg-ink`;
          const chipStyle = !palette.text && palette.stroke ? { color: palette.stroke, borderColor: `${palette.stroke}59` } : undefined;
          return (
            <div key={i} className="absolute flex flex-col items-end gap-1.5" style={{ right: 0, top: `${y}%`, transform: "translateY(-50%)" }}>
              <span className={chipClassName} style={chipStyle} data-split-chip={node.kind}>
                {node.amount} {node.kind === "fee" ? "" : "net"}
              </span>
              <span className="font-data text-xs uppercase tracking-wide text-slate">{node.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
