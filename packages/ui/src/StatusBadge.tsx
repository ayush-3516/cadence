const STATUS_COLOR: Record<string, string> = {
  active: "mint",
  trialing: "mint",
  past_due: "signal",
  paused: "signal",
  canceled: "slate",
};

export interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const color = STATUS_COLOR[status] ?? "slate";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-${color}/10 text-${color}`}
    >
      {status}
    </span>
  );
}
