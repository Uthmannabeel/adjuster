import Link from "next/link";
import { EvidenceChain, type Station } from "@/components/adjuster/EvidenceChain";

export const dynamic = "force-dynamic";

/**
 * The specimen is a REAL claim: policy № 3, settled on Coston2 on 20 Jul 2026.
 * 11.7 mm rainfall attested in FDC round 1401182 → 23.29 C2FLR paid.
 */
const SPECIMEN_SETTLE_TX =
  "https://coston2-explorer.flare.network/tx/0x6883b850c70ca8637cf71ed208c388735d07fe48216129b6e0878cc78db9e914";

const SPECIMEN: Station[] = [
  {
    id: "photo",
    title: "Damage photograph",
    status: "done",
    lines: [{ text: "Flood damage, Port Harcourt — GPS + timestamp in EXIF" }],
  },
  {
    id: "enclave",
    title: "Confidential verification",
    status: "done",
    lines: [
      { text: "0.52 km from the insured address · on the coverage date", tone: "green" },
      { text: "No reuse across prior claims (perceptual match sweep)", tone: "green" },
      { text: "Verified in enclave memory — the photo never left it", tone: "green" },
    ],
  },
  {
    id: "evidence",
    title: "Evidence recorded on-chain",
    status: "done",
    lines: [{ text: "Signed verdict accepted by ClaimPayout · spoofed signers revert", tone: "green" }],
  },
  {
    id: "weather",
    title: "Weather attested by Flare",
    status: "done",
    lines: [{ text: "11.7 mm rainfall attested · FDC round 1401182 · threshold 5.0 mm", tone: "green" }],
  },
  {
    id: "payout",
    title: "Payout",
    status: "done",
    lines: [{ text: "23.29 C2FLR paid — settled 20 Jul 2026", href: SPECIMEN_SETTLE_TX, tone: "green" }],
  },
];

const STEPS = [
  {
    n: "01",
    title: "One photograph is the claim",
    body: "The claimant photographs the damage. GPS and capture time ride along in the file's EXIF — nothing else is asked for.",
  },
  {
    n: "02",
    title: "A confidential enclave adjusts it",
    body: "The photo goes straight to a TEE (Google Confidential Space), which checks the location against the policy, the date against coverage, and the image against every prior claim — catching recycled evidence by perceptual fingerprint. The photo is never stored, and never seen by the insurer.",
  },
  {
    n: "03",
    title: "The chain checks the adjuster",
    body: "The enclave signs its verdict in Flare's FCC wire format. ClaimPayout recovers the signer and verifies its vTPM attestation on-chain — a spoofed enclave is rejected in the same block it tries.",
  },
  {
    n: "04",
    title: "The weather testifies, the payout executes",
    body: "Flare's Data Connector attests rainfall at the insured location and date (Web2Json), the contract verifies the Merkle proof itself, FTSOv2 converts the USD payout, and the funds move.",
  },
];

export default function Home() {
  const contract = process.env.CLAIM_PAYOUT_ADDRESS ?? null;

  return (
    <main className="flex-1">
      {/* Masthead */}
      <header className="border-b border-[var(--color-rule)]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <span className="mono font-bold tracking-[0.18em] uppercase text-sm">◈ Adjuster</span>
          <nav className="mono text-[0.72rem] uppercase tracking-[0.14em] flex gap-5">
            <Link href="/claim" className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
              File a claim
            </Link>
            <Link href="/desk" className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
              Claims desk
            </Link>
            <Link
              href="/registry"
              className="hidden sm:inline text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              Registry
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero — thesis left, a real settled claim file right */}
      <section className="max-w-6xl mx-auto px-6 pt-14 pb-16 grid lg:grid-cols-[1.1fr_1fr] gap-10 items-start">
        <div>
          <p className="eyebrow">Confidential parametric insurance · Flare Coston2</p>
          <h1 className="font-serif text-5xl sm:text-6xl leading-[1.04] mt-4">
            The claim that
            <br />
            settles <span className="italic">itself.</span>
          </h1>
          <p className="text-[var(--color-ink-soft)] text-lg mt-6 max-w-xl">
            Adjuster pays flood claims from a single photograph. A confidential enclave verifies
            the damage without ever revealing the photo, Flare&rsquo;s oracles attest the weather,
            and the payout executes on-chain — no adjuster visit, no paperwork, no waiting.
          </p>

          <div className="flex flex-wrap gap-3 mt-8">
            <Link href="/claim" className="btn inline-block">
              File a demo claim
            </Link>
            <Link href="/desk" className="btn btn-ghost inline-block">
              Open the claims desk
            </Link>
          </div>

          {/* The one costed number */}
          <div className="mt-10 border border-[var(--color-rule)]">
            <div className="grid sm:grid-cols-2">
              <div className="p-5 border-b sm:border-b-0 sm:border-r border-[var(--color-rule)]">
                <p className="eyebrow">A manual claim</p>
                <p className="font-serif text-3xl mt-2">$300–900</p>
                <p className="mono text-[0.72rem] text-[var(--color-ink-faint)] mt-1">
                  in adjustment costs · paid in 10–30 days
                </p>
                <p className="mono text-[0.68rem] text-[var(--color-ink-faint)] mt-3 pt-3 border-t border-[var(--color-rule)] leading-relaxed">
                  notice → forms → adjuster visit → review → negotiation → cheque
                </p>
              </div>
              <div className="p-5 bg-[var(--color-paper-2)]">
                <p className="eyebrow">An Adjuster claim</p>
                <p className="font-serif text-3xl mt-2">&lt; $0.01</p>
                <p className="mono text-[0.72rem] text-[var(--color-ink-faint)] mt-1">
                  in gas · paid in about 4 minutes
                </p>
                <p className="mono text-[0.68rem] text-[var(--color-ink-faint)] mt-3 pt-3 border-t border-[var(--color-rule)] leading-relaxed">
                  photograph → verified in the enclave → paid
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="doc-card p-6 relative">
          <div className="doc-rule pb-3 mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Claim file · Policy № 3</p>
              <h2 className="font-serif text-2xl mt-0.5">A real claim, settled.</h2>
            </div>
            <span className="stamp stamp-green shrink-0">Paid</span>
          </div>
          <EvidenceChain stations={SPECIMEN} />
          <p className="mono text-[0.68rem] text-[var(--color-ink-faint)] mt-5 doc-rule border-b-0 border-t pt-3">
            Settled end-to-end on Coston2, 20 Jul 2026 — every link above is checkable on the
            explorer.
          </p>
        </div>
      </section>

      {/* The gap it closes · the record so far */}
      <section className="border-t border-[var(--color-rule)] bg-[var(--color-paper-2)]">
        <div className="max-w-6xl mx-auto px-6 py-5 grid sm:grid-cols-2 gap-x-10 gap-y-4">
          <p className="mono text-[0.72rem] leading-relaxed text-[var(--color-ink-soft)]">
            <span className="eyebrow block mb-1">The gap</span>
            398 natural disasters in 2023 · $380B in losses · 69% of it uninsured —{" "}
            <a
              className="underline underline-offset-2"
              href="https://www.aon.com/en/insights/reports/climate-and-catastrophe-report"
              target="_blank"
              rel="noopener noreferrer"
            >
              Aon, Climate &amp; Catastrophe Insight
            </a>
          </p>
          <p className="mono text-[0.72rem] leading-relaxed text-[var(--color-ink-soft)]">
            <span className="eyebrow block mb-1">On the record — Coston2, 12 Aug 2026</span>
            4 claims settled on-chain · 95.8 C2FLR paid · attested TEE live ·{" "}
            <Link href="/desk" className="underline underline-offset-2">
              read it live on the claims desk
            </Link>
          </p>
        </div>
      </section>

      {/* How a claim moves */}
      <section className="border-t border-[var(--color-rule)]">
        <div className="max-w-6xl mx-auto px-6 py-14">
          <div className="doc-rule pb-3 mb-8">
            <h2 className="eyebrow">How a claim moves</h2>
          </div>
          <div className="grid sm:grid-cols-2 gap-5">
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
          <p className="mono text-[0.72rem] text-[var(--color-ink-soft)] mt-6">
            Four Flare protocols carry load: vTPM attestation verification (on-chain TEE proof) ·
            FCC ActionResult wire format (enclave settlements) · FDC Web2Json (weather) · FTSOv2
            (USD conversion).
          </p>
        </div>
      </section>

      {/* Why confidential + provenance */}
      <section className="border-t border-[var(--color-rule)]">
        <div className="max-w-6xl mx-auto px-6 py-14 grid lg:grid-cols-2 gap-10">
          <div>
            <div className="doc-rule pb-3 mb-5">
              <h2 className="eyebrow">Why confidential</h2>
            </div>
            <p className="text-[var(--color-ink-soft)] leading-relaxed max-w-prose">
              Claim photos show the inside of people&rsquo;s homes on their worst day. Adjuster
              reads them in a hardware-isolated enclave and keeps only hashes: enough to verify the
              claim and catch the same photo filed twice, without an insurer — or us — ever holding
              the image. The insurer&rsquo;s desk sees verdicts and proofs, not photographs.
            </p>
          </div>
          <div>
            <div className="doc-rule pb-3 mb-5">
              <h2 className="eyebrow">Provenance &amp; honest limits</h2>
            </div>
            <p className="text-[var(--color-ink-soft)] leading-relaxed max-w-prose">
              Adjuster is built on{" "}
              <Link href="/registry" className="underline underline-offset-2">
                Proof of Real
              </Link>
              , our pre-existing media-authenticity registry, now serving as the hash-only evidence
              store. This is a Coston2 testnet demonstration with demo-scale payouts — parametric
              triggers, EXIF checks, and perceptual matching have known limits, and we document
              them rather than hide them.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--color-rule)]">
        <div className="max-w-6xl mx-auto px-6 py-6 mono text-[0.72rem] text-[var(--color-ink-faint)] flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>Adjuster · confidential parametric claims on Flare</span>
          <span className="flex gap-4">
            {contract && (
              <a
                className="underline underline-offset-2"
                href={`https://coston2-explorer.flare.network/address/${contract}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                ClaimPayout ↗
              </a>
            )}
            <span>TEE + FDC + FTSOv2 · Coston2</span>
          </span>
        </div>
      </footer>
    </main>
  );
}
