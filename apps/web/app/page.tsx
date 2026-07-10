import { Hero } from "../components/marketing/Hero.js";
import { Wedge } from "../components/marketing/Wedge.js";
import { HowItWorks } from "../components/marketing/HowItWorks.js";
import { Pricing } from "../components/marketing/Pricing.js";
import { ClosingCta } from "../components/marketing/ClosingCta.js";

export default function RootPage() {
  return (
    <main className="marketing-page min-h-screen">
      <Hero />
      <Wedge />
      <HowItWorks />
      <Pricing />
      <ClosingCta />
    </main>
  );
}
