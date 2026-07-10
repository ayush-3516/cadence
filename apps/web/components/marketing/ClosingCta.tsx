export function ClosingCta() {
  return (
    <section className="px-6 sm:px-12 py-16 md:py-24 max-w-7xl mx-auto text-center">
      <h2 className="font-display font-bold text-2xl sm:text-3xl mb-8" style={{ textWrap: "balance" }}>
        Start splitting payments on-chain.
      </h2>
      <div className="flex flex-wrap gap-3 justify-center">
        <a href="#" className="rounded-lg bg-sapphire text-paper font-body font-semibold text-sm px-5 py-3 hover:-translate-y-px transition-transform">
          Start building
        </a>
        <a href="#" className="rounded-lg border border-paper/20 text-paper font-body font-semibold text-sm px-5 py-3 hover:border-paper/35 transition-colors">
          Read the docs
        </a>
      </div>
    </section>
  );
}
