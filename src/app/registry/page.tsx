import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { recentRegistrations } from "@/lib/registry";
import { RegistryApp } from "@/components/RegistryApp";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Evidence Registry — Adjuster",
  description:
    "The tamper-evident media registry underneath Adjuster: register originals, verify any image, and check the hash-chained ledger anchored on Flare.",
};

const STEPS = [
  {
    n: "01",
    title: "Register",
    body: "Upload an original. We seal its exact-byte hash and a perceptual fingerprint into a tamper-evident public ledger.",
  },
  {
    n: "02",
    title: "Verify",
    body: "Anyone can upload an image and check it against the ledger in milliseconds — no account, no trust required.",
  },
  {
    n: "03",
    title: "Prove",
    body: "Get an evidence-backed verdict: original, altered copy, or unknown. The ledger's history is anchored on Flare, so not even we can rewrite it.",
  },
];

export default async function RegistryPage() {
  const ledger = await recentRegistrations(20);

  return (
    <main className="flex-1">
      {/* Masthead */}
      <header className="border-b border-[var(--color-rule)]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="mono font-bold tracking-[0.18em] uppercase text-sm">
            ◈ Adjuster
          </Link>
          <span className="eyebrow hidden sm:block">Evidence Registry · Proof of Real</span>
          <ThemeToggle />
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-12 text-center">
        <p className="eyebrow">Public · Tamper-evident · No account required</p>
        <h1 className="font-serif text-5xl sm:text-7xl leading-[1.02] mt-4 max-w-3xl mx-auto">
          Don&rsquo;t trust the image.
          <br />
          <span className="italic">Verify</span> it.
        </h1>
        <p className="text-[var(--color-ink-soft)] text-lg mt-6 max-w-2xl mx-auto">
          This registry is the evidence store underneath Adjuster&rsquo;s claims: creators seal
          originals, claims leave hash-only fingerprints, and anyone can verify a file against
          them.
        </p>
      </section>

      {/* How it works */}
      <section className="max-w-5xl mx-auto px-6 pb-14">
        <div className="grid sm:grid-cols-3 gap-5">
          {STEPS.map((step) => (
            <div key={step.n} className="doc-card p-6">
              <p className="mono text-[var(--color-ink-faint)] text-2xl">{step.n}</p>
              <h3 className="font-serif text-2xl mt-2">{step.title}</h3>
              <p className="text-[var(--color-ink-soft)] text-sm mt-2 leading-relaxed">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* App */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="doc-rule pb-3 mb-8">
          <h2 className="eyebrow">The Registry</h2>
        </div>
        <RegistryApp initialLedger={ledger} />
      </section>

      <footer className="border-t border-[var(--color-rule)]">
        <div className="max-w-5xl mx-auto px-6 py-6 mono text-[0.72rem] text-[var(--color-ink-faint)] flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>Proof of Real · the evidence registry underneath Adjuster</span>
          <span>SHA-256 + dHash · anchored on Flare Coston2 · Next.js</span>
        </div>
      </footer>
    </main>
  );
}
