const USE_CASES = [
  {
    audience: "AI tools",
    copy: "Meter API usage, bill monthly, and split revenue with your model provider automatically — every charge settles the split in the same transaction.",
  },
  {
    audience: "Creators",
    copy: "Run a subscription tier and pay your editor or co-host their cut the instant a fan's payment clears, with no manual accounting.",
  },
  {
    audience: "Agencies",
    copy: "Bill clients recurring and route each project's revenue-share to the right contractor without ever touching a spreadsheet.",
  },
];

export function Wedge() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-20 max-w-7xl mx-auto">
      <div className="grid sm:grid-cols-3 gap-6">
        {USE_CASES.map((useCase) => (
          <div key={useCase.audience} className="rounded-xl border border-paper/10 p-6">
            <h3 className="font-display font-semibold text-lg mb-2">{useCase.audience}</h3>
            <p className="font-body text-sm leading-relaxed text-paper/65">{useCase.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
