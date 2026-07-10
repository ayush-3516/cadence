const STEPS = [
  {
    title: "Subscribe",
    copy: "A subscriber signs a gasless permit — no upfront transaction, no manual approval flow.",
  },
  {
    title: "Charge",
    copy: "Anyone can trigger the charge once it's due; Cadence's scheduler does this automatically, on-chain, permissionlessly.",
  },
  {
    title: "Split",
    copy: "The moment the charge clears, the fee and every recipient's share settle atomically in the same transaction.",
  },
];

export function HowItWorks() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-20 max-w-7xl mx-auto">
      <h2 className="font-display font-bold text-2xl sm:text-3xl mb-10" style={{ textWrap: "balance" }}>
        How it works
      </h2>
      <div className="grid sm:grid-cols-3 gap-8">
        {STEPS.map((step, i) => (
          <div key={step.title}>
            <div className="font-data text-sm text-slate mb-2">{String(i + 1).padStart(2, "0")}</div>
            <h3 className="font-display font-semibold text-lg mb-2">{step.title}</h3>
            <p className="font-body text-sm leading-relaxed text-paper/65">{step.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
