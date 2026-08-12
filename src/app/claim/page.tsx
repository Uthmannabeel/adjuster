import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ClaimFlow } from "@/components/adjuster/ClaimFlow";

export const metadata: Metadata = {
  title: "File a claim — Adjuster",
  description:
    "File a parametric flood claim from a single photograph: confidential verification in a TEE, weather attested by Flare's Data Connector, payout in minutes.",
};

export default function ClaimPage() {
  return (
    <main className="flex-1">
      <header className="border-b border-[var(--color-rule)]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="mono font-bold tracking-[0.18em] uppercase text-sm">
            ◈ Adjuster
          </Link>
          <nav className="mono text-[0.72rem] uppercase tracking-[0.14em] flex gap-5">
            <span className="text-[var(--color-ink)]">File a claim</span>
            <Link href="/desk" className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
              Claims desk
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <section className="max-w-5xl mx-auto px-6 pt-10 pb-6">
        <p className="eyebrow">Claim intake · Coston2 testnet</p>
        <h1 className="font-serif text-4xl sm:text-5xl leading-tight mt-2">File a claim.</h1>
        <p className="text-[var(--color-ink-soft)] mt-3 max-w-2xl">
          One photograph is the whole claim. It is verified inside a confidential enclave — never
          uploaded to us — the weather is attested by Flare&rsquo;s oracles, and an eligible claim
          pays out in minutes.
        </p>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-20">
        <ClaimFlow />
      </section>

      <footer className="border-t border-[var(--color-rule)]">
        <div className="max-w-5xl mx-auto px-6 py-6 mono text-[0.72rem] text-[var(--color-ink-faint)] flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>Testnet demonstration — demo-scale payouts, not production insurance</span>
          <Link href="/registry" className="underline underline-offset-2">
            Evidence registry
          </Link>
        </div>
      </footer>
    </main>
  );
}
