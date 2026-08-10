import type { Metadata } from "next";
import Link from "next/link";
import {
  adjusterConfigured,
  claimsAddress,
  formatEther,
  listPolicies,
  poolBalanceWei,
  type AdjusterPolicy,
} from "@/lib/adjuster";
import { DeskRefresh } from "@/components/adjuster/DeskRefresh";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Claims desk — Adjuster",
  description:
    "The insurer's view: every policy on ClaimPayout, its evidence status, attestation, and settlement — read live from Coston2.",
};

function statusOf(p: AdjusterPolicy): { label: string; tone: "green" | "amber" | "red" | "ink" } {
  if (p.settled) {
    return p.paidOut
      ? { label: "Paid", tone: "green" }
      : { label: "Not triggered", tone: "amber" };
  }
  if (p.evidenceApproved) return { label: "Awaiting weather", tone: "ink" };
  return { label: "Open", tone: "ink" };
}

const TONE_TEXT = {
  green: "text-[var(--color-stamp-green)] border-[var(--color-stamp-green)]",
  amber: "text-[var(--color-stamp-amber)] border-[var(--color-stamp-amber)]",
  red: "text-[var(--color-stamp-red)] border-[var(--color-stamp-red)]",
  ink: "text-[var(--color-ink-soft)] border-[var(--color-rule)]",
} as const;

function fmtFlr(wei: string): string {
  return Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export default async function DeskPage() {
  const configured = adjusterConfigured();
  let policies: AdjusterPolicy[] = [];
  let poolWei: string | null = null;
  let loadError: string | null = null;

  if (configured) {
    try {
      [policies, poolWei] = await Promise.all([listPolicies(), poolBalanceWei()]);
    } catch (error: unknown) {
      // Ethers appends "(code=TIMEOUT, version=…)"; an insurer reading a desk
      // does not need the client library's version number.
      const raw = error instanceof Error ? error.message : "";
      const cleaned = raw.replace(/\s*\((?:code|version|argument|value)=.*\)\s*$/i, "").trim();
      loadError = cleaned.length > 0 && cleaned.length < 160
        ? cleaned
        : "The Coston2 node did not answer in time.";
    }
  }

  // With no data, every tile would read as a real zero — an empty book rather
  // than an unread one. Show that the number is unknown instead.
  const unread = loadError !== null || !configured;
  const stat = (value: string | number): string => (unread ? "—" : String(value));

  const paid = policies.filter((p) => p.paidOut);
  const totalPaidWei = paid.reduce((sum, p) => sum + BigInt(p.paidWei), BigInt(0)).toString();
  const awaiting = policies.filter((p) => p.evidenceApproved && !p.settled).length;
  const contract = claimsAddress();

  return (
    <main className="flex-1">
      <header className="border-b border-[var(--color-rule)]">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="mono font-bold tracking-[0.18em] uppercase text-sm">
            ◈ Adjuster
          </Link>
          <nav className="mono text-[0.72rem] uppercase tracking-[0.14em] flex gap-5">
            <Link href="/claim" className="text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
              File a claim
            </Link>
            <span className="text-[var(--color-ink)]">Claims desk</span>
          </nav>
        </div>
      </header>

      <section className="max-w-5xl mx-auto px-6 pt-10 pb-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="eyebrow">Insurer view · read live from Coston2</p>
            <h1 className="font-serif text-4xl sm:text-5xl leading-tight mt-2">Claims desk.</h1>
            <p className="text-[var(--color-ink-soft)] mt-3 max-w-2xl">
              Every policy on the book, with its evidence trail: whether the enclave&rsquo;s verdict
              was TEE-attested, what the weather oracle said, and what was paid. No adjuster ever
              saw a claimant&rsquo;s photo.
            </p>
          </div>
          <DeskRefresh />
        </div>
      </section>

      {/* Ledger stats */}
      <section className="max-w-5xl mx-auto px-6 pb-8">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="doc-card p-4">
            <p className="eyebrow">Policies on book</p>
            <p className="font-serif text-3xl mt-1">{stat(policies.length)}</p>
          </div>
          <div className="doc-card p-4">
            <p className="eyebrow">Awaiting weather</p>
            <p className="font-serif text-3xl mt-1">{stat(awaiting)}</p>
          </div>
          <div className="doc-card p-4">
            <p className="eyebrow">Claims paid</p>
            <p className="font-serif text-3xl mt-1">
              {stat(paid.length)}
              {!unread && (
                <span className="mono text-[0.72rem] text-[var(--color-ink-faint)] ml-2">
                  {fmtFlr(totalPaidWei)} C2FLR
                </span>
              )}
            </p>
          </div>
          <div className="doc-card p-4">
            <p className="eyebrow">Payout pool</p>
            <p className="font-serif text-3xl mt-1">
              {poolWei !== null && !unread ? fmtFlr(poolWei) : "—"}
              <span className="mono text-[0.72rem] text-[var(--color-ink-faint)] ml-2">C2FLR</span>
            </p>
          </div>
        </div>
      </section>

      {/* Claims register */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="doc-rule pb-3 mb-5 flex items-baseline justify-between">
          <h2 className="eyebrow">Claims register</h2>
          {contract && (
            <a
              className="mono text-[0.68rem] text-[var(--color-ink-faint)] underline underline-offset-2"
              href={`https://coston2-explorer.flare.network/address/${contract}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              ClaimPayout {contract.slice(0, 8)}… ↗
            </a>
          )}
        </div>

        {!configured && (
          <div className="doc-card p-6">
            <p className="text-sm text-[var(--color-ink-soft)]">
              Adjuster is not configured on this deployment — the ClaimPayout contract address and
              relay key are missing.
            </p>
          </div>
        )}

        {loadError && (
          <div className="doc-card p-6">
            <p className="eyebrow mb-2">Register unavailable</p>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {loadError} The book is held on-chain and was not read on this request — the figures
              above are unknown, not zero. Refresh to try again.
            </p>
          </div>
        )}

        {configured && !loadError && (
          <div className="overflow-x-auto doc-card">
            <table className="w-full text-left mono text-[0.78rem]">
              <thead>
                <tr className="border-b border-[var(--color-rule)] text-[0.68rem] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                  <th className="px-4 py-3 font-normal">№</th>
                  <th className="px-4 py-3 font-normal">Coverage</th>
                  <th className="px-4 py-3 font-normal">Insured location</th>
                  <th className="px-4 py-3 font-normal">Trigger</th>
                  <th className="px-4 py-3 font-normal">Payout</th>
                  <th className="px-4 py-3 font-normal">Evidence</th>
                  <th className="px-4 py-3 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {policies.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-[var(--color-ink-soft)]">
                      No policies on the book yet — open one from the claim page.
                    </td>
                  </tr>
                )}
                {policies.map((p) => {
                  const status = statusOf(p);
                  return (
                    <tr key={p.policyId} className="border-b border-[var(--color-rule)] last:border-b-0 align-top">
                      <td className="px-4 py-3 font-bold">{p.policyId}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{p.date}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {p.lat}, {p.lon}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        ≥ {(p.rainThresholdMmE2 / 100).toFixed(1)} mm
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        ${(p.payoutUsdE2 / 100).toFixed(2)}
                        {p.paidOut && (
                          <span className="block text-[0.68rem] text-[var(--color-stamp-green)]">
                            {fmtFlr(p.paidWei)} C2FLR
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {p.evidenceApproved ? (
                          <>
                            <span
                              className={
                                p.evidenceAttested
                                  ? "text-[var(--color-stamp-green)]"
                                  : "text-[var(--color-stamp-amber)]"
                              }
                            >
                              {p.evidenceAttested ? "✓ attested TEE" : "✓ dev signer"}
                            </span>
                            <span className="block text-[0.68rem] text-[var(--color-ink-faint)]">
                              {p.evidenceHash.slice(0, 10)}…
                            </span>
                          </>
                        ) : (
                          <span className="text-[var(--color-ink-faint)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block border px-1.5 py-0.5 text-[0.65rem] uppercase tracking-[0.12em] whitespace-nowrap ${TONE_TEXT[status.tone]}`}
                        >
                          {status.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mono text-[0.68rem] text-[var(--color-ink-faint)] mt-4">
          Evidence hashes are the only trace a claim photo leaves outside the enclave. Attested
          evidence was signed inside Google Confidential Space and proven so on-chain; dev-signer
          evidence is flagged as such by the contract itself.
        </p>
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
