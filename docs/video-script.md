# Demo video script — ~2:45 target

**Pre-flight (do all of these BEFORE recording, in order):**

1. `node scripts/health-check.mjs --app https://adjuster.agentarc.online` — all green,
   no warnings. If the TEE quote is expired or a wallet is below floor, fix first.
2. `node scripts/register-oidc-keys.mjs --check` — nothing to do.
3. Pool must cover one payout (~25 C2FLR) with margin; deployer above 10.
4. Open tabs in order: ① `/` ② `/claim` ③ `/desk` ④ `https://tee.agentarc.online/health`
   ⑤ Coston2 explorer on the ClaimPayout address. Close everything else. Hide bookmarks bar.
5. 1080p or higher; system notifications off. Record with OBS or Clipchamp screen capture.
6. Talk over the recording as you go — one take is fine; judges prefer real over polished.

---

## 0:00 — The problem and the number (tab ①, landing page)

Scroll slowly past the hero specimen claim.

> "This is Adjuster. A manual storm-damage claim costs the insurer three to nine
> hundred dollars and takes the claimant up to a month — and it costs the claimant
> something else: photographs of the inside of their home, handed to a company's
> claims system forever. Adjuster settles the same claim for under a cent in gas,
> in about four minutes, and nobody — not the insurer, not us — ever sees the photo."

## 0:30 — Proof there's a real enclave (tab ④, /health JSON)

Point at `inConfidentialSpace: true`, `hwmodel: GCP_INTEL_TDX`, `onChain: true`.

> "The verifier isn't a server pretending to be trusted. It's a Google Confidential
> Space enclave on Intel TDX. Its signing key was generated inside the enclave —
> the launch policy forbids injecting one — and it registered its own attestation
> on Flare. The chain knows this exact container image is the thing signing verdicts.
> Even the TLS certificate was issued to code inside the enclave, so no proxy ever
> holds a plaintext image."

## 1:00 — A full claim, live (tab ②, /claim)

Pick a policy → "use a sample photo" → submit. Narrate the docket as it fills:
enclave verdict (location ✓ date ✓ no reuse ✓, **attested TEE**) → evidence
accepted on-chain → FDC weather round → payout.

> "Here's a claim, end to end, live on Coston2. The photo goes from the browser
> straight to the enclave — it never touches our servers. Inside, it's checked
> for where it was taken, when it was taken, and whether this photograph has ever
> been used on another claim — that's fraud detection across all policies, done on
> perceptual fingerprints, not images. The enclave signs a verdict; the contract
> checks the signature AND checks that signer has a live attestation on-chain.
> Then the Flare Data Connector attests the rainfall at those exact coordinates
> with a Merkle proof, FTSO converts the payout to FLR at the live price — and paid."

(FDC takes ~90 s. Either talk through it — "the attestation round is running now" —
or jump-cut and say so honestly on screen.)

## 2:00 — Try to cheat it (the money shot)

On the result, use the spoof demo (tampered payload / unattested signer), or run
`node scripts/adjuster-e2e.mjs --spoof` in a visible terminal.

> "Now the part that matters. Same claim, one byte of the verdict tampered —
> rejected: `NotAttestedTee`. A verdict signed by a wallet that never attested —
> rejected again. Flare's own weather-insurance example trusts whatever TEE address
> the owner set. Here, the key earns its authority by attestation, and the contract
> enforces it."

## 2:25 — The insurer's view + close (tab ③, /desk)

Point at the green **attested TEE** rows, the pool, the settled policies.

> "The insurer sees verdicts, attestation state, and payouts — never a photograph.
> Four Flare protocols carry this: vTPM attestation, FDC Web2Json, FTSOv2, and the
> FCC ActionResult format, so this enclave can register as a real FCC extension
> next. Everything you saw is live on Coston2 — every transaction in the repo's
> work ledger is clickable. Adjuster: parametric insurance that pays fast without
> asking people to trade their privacy for it."

---

**After recording:** upload (YouTube unlisted is fine) → paste the link into
`docs/submission.md` (Demo section) and the README → commit → submit the BUIDL.
