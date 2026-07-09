export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-ink text-paper">
      <div className="max-w-2xl mx-auto p-6">{children}</div>
    </div>
  );
}
