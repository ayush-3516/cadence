import { SplitFlow } from "@cadence/ui";

export function Hero() {
  return (
    <section className="grid md:grid-cols-[minmax(280px,1fr)_minmax(320px,1.4fr)] items-center gap-8 md:gap-16 px-6 sm:px-12 py-16 md:py-24 max-w-7xl mx-auto">
      <div>
        <div className="inline-flex items-center gap-2 font-data text-xs uppercase tracking-wide text-slate mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-mint" style={{ boxShadow: "0 0 0 3px rgba(23,184,144,0.18)" }} />
          Live on Base
        </div>
        <h1 className="font-display font-bold text-4xl sm:text-5xl leading-[1.04] tracking-tight mb-5" style={{ textWrap: "balance" }}>
          One payment, split <span className="text-mint">instantly</span>, on-chain.
        </h1>
        <p className="font-body text-base sm:text-lg leading-relaxed text-paper/70 max-w-[46ch] mb-8">
          Cadence charges your subscribers in USDC and settles every fee and payout the moment the charge clears — no invoicing, no manual
          splits, no waiting on a payout batch. Built for AI tools, creators, and agencies who bill recurring and pay out revenue-share the
          same instant.
        </p>
        <div className="flex flex-wrap gap-3 mb-10">
          <a href="#" className="rounded-lg bg-sapphire text-paper font-body font-semibold text-sm px-5 py-3 hover:-translate-y-px transition-transform">
            Start building
          </a>
          <a href="#" className="rounded-lg border border-paper/20 text-paper font-body font-semibold text-sm px-5 py-3 hover:border-paper/35 transition-colors">
            Read the docs
          </a>
        </div>
        <div className="flex flex-wrap gap-4 font-data text-xs text-slate">
          <span>
            Built for <span className="text-paper/55">AI tools</span>
          </span>
          <span>
            · <span className="text-paper/55">Creators</span>
          </span>
          <span>
            · <span className="text-paper/55">Agencies</span>
          </span>
        </div>
      </div>

      <SplitFlow
        amount="20.00"
        feeAmount="0.75"
        feeLabel="platform"
        recipients={[
          { amount: "14.44", label: "founder.eth" },
          { amount: "4.81", label: "agency.eth" },
        ]}
      />
    </section>
  );
}
