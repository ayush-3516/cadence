import Link from "next/link";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/plans", label: "Plans" },
  { href: "/dashboard/subscriptions", label: "Subscriptions" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/developers", label: "Developers" },
];

export function DashboardNav() {
  return (
    <nav className="w-56 shrink-0 border-r border-slate/15 p-4">
      <div className="font-display text-lg mb-6">Cadence</div>
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="block rounded-md px-3 py-2 text-sm font-body hover:bg-sapphire/10">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
