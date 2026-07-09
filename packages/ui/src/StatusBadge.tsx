// Full class strings, not interpolated fragments — Tailwind's static analyzer
// only extracts whole utility-class literals from source, so a template
// literal like `bg-${color}/10` never emits any CSS for the class it builds.
const STATUS_CLASSES: Record<string, string> = {
  active: "bg-mint/10 text-mint",
  trialing: "bg-mint/10 text-mint",
  past_due: "bg-signal/10 text-signal",
  paused: "bg-signal/10 text-signal",
  canceled: "bg-slate/10 text-slate",
};
const DEFAULT_CLASSES = "bg-slate/10 text-slate";

export interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const classes = STATUS_CLASSES[status] ?? DEFAULT_CLASSES;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{status}</span>;
}
