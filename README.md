# Adjuster

**The confidential evidence layer for insurance claims.** A claimant photographs storm damage. The photo is verified *inside a hardware enclave* — never seen by the insurer, never stored by us — and the enclave's signed verdict settles a parametric policy on Flare. Rainfall is attested by the Flare Data Connector, the payout is converted at the FTSOv2 FLR/USD price, and the money moves in about four minutes.

Built for the **Flare Summer Signal** hackathon — *Confidential Compute Apps* bounty. Live on **Coston2**.

> A manual damage claim costs the insurer **$300–900** and takes the claimant **10–30 days**. Adjuster settled one on-chain for **under $0.01 in gas, in ~4 minutes** — without any human ever seeing the photograph.

---

## Why this exists

Parametric insurance pays on a trigger — "it rained 50mm at your address, here's your money" — so it skips the loss adjuster entirely. That is also its weakness: a pure weather trigger cannot tell whether *you* actually suffered damage, and it has no defence against the same photograph being recycled across five policies.

Adding evidence normally means surrendering privacy. Photographs of a flooded home are photographs of the inside of someone's home. Handing them to an insurer's claims system, and to whoever that system is breached by, is the price of being paid.

Adjuster removes that trade. Evidence is examined in a Trusted Execution Environment, and only a *verdict* — signed by a key that exists nowhere but inside the enclave, and provably so on-chain — ever leaves it.

## What the enclave actually checks

The claimant's browser uploads the photograph **directly to the enclave**. It never touches this application's servers.

| Check | Method | Catches |
|---|---|---|
| **Location** | EXIF GPS, haversine distance against the policy's coordinates *read from the contract* | a photo taken somewhere else |
| **Date** | EXIF `DateTimeOriginal` against the policy's coverage window | a photo from before the storm |
| **Reuse** | perceptual hash (dHash) against every prior claim fingerprint, with a same-policy re-upload exemption | one photograph claimed on several policies |
| **Detail** | degenerate-fingerprint rejection | a blank frame submitted to evade the reuse check |

The registry stores **hashes only** — it is queried by fingerprint, never by image. What comes back out of the enclave is an [FCC `ActionResult`](https://dev.flare.network/fcc/): the verdict, ABI-encoded and signed EIP-191, which `ClaimPayout.submitEvidence` reconstructs and `ecrecover`s.

## How Flare carries the weight

Four Flare protocols, each load-bearing — remove any one and the product stops working.

| Protocol | Role |
|---|---|
| **vTPM attestation** (`flare-vtpm-attestation`) | The contract verifies a Google Confidential Space token on-chain (RS256, real issuer keys registered) and will only accept evidence signed by a key with a live attested quote. An unattested signer reverts with `NotAttestedTee`. |
| **FDC — Web2Json** | Rainfall at the policy's coordinates and date, attested from Open-Meteo through the Data Connector with a Merkle proof. The contract pins the request URL *and* the canonical query parameters, so the attested figure cannot be redirected to a different place or day. |
| **FTSOv2** | Converts the policy's USD payout into FLR at the live feed price at settlement. |
| **FCC wire format** | The enclave signs settlements in Flare Confidential Compute's own `ActionResult` format, so the same enclave can register as a real FCC extension without changing the contract. |

**This closes a real gap in Flare's own example.** Flare's `fcc-weather-insurance` sample trusts an owner-set `teeAddress` — the contract believes whichever address the owner nominated. Adjuster instead requires the TEE to *prove itself* to the chain: the enclave generates its signing key inside the enclave (the Confidential Space launch policy forbids injecting one), submits its attestation token to `FlareVtpmAttestation.verifyAndAttest`, and re-attests before the quote expires each hour. The key earns its authority by attestation rather than by an owner vouching for it.

## Live on Coston2

| Contract | Address |
|---|---|
| `ClaimPayout` | [`0x8af8843C9F2474F0528970161bc4C1db62e3B8b9`](https://coston2-explorer.flare.network/address/0x8af8843C9F2474F0528970161bc4C1db62e3B8b9) |
| `FlareVtpmAttestation` | [`0xdf7fb88FcE2a9457a1a174845d702bF91aC8E19A`](https://coston2-explorer.flare.network/address/0xdf7fb88FcE2a9457a1a174845d702bF91aC8E19A) |
| `OidcSignatureVerification` | [`0xf9b394C4583eD23A1b97f93428ea9A3e70Ad5A74`](https://coston2-explorer.flare.network/address/0xf9b394C4583eD23A1b97f93428ea9A3e70Ad5A74) |

Two claims have run the full lifecycle and paid out on-chain:

- **Policy #3** — evidence accepted → FDC round 1401182 attested 11.7mm → [23.29 C2FLR paid](https://coston2-explorer.flare.network/tx/0x6883b850c70ca8637cf71ed208c388735d07fe48216129b6e0878cc78db9e914)
- **Policy #5** — re-verified end-to-end through the serverless API routes → FDC round 1403092 → [22.45 C2FLR paid](https://coston2-explorer.flare.network/tx/0xbb40b3b67f3fb4b03989798d1786c9b4df0818118c5769cca3b7e8c4901762ce)

And spoofing is rejected, not merely discouraged: submitting a tampered payload, or signing with a wallet that has no attested quote, both revert with `NotAttestedTee` on-chain.

## Architecture

```
Browser ──photo──▶ ENCLAVE (Confidential Space)          ← the photo goes here and stops here
                     │  EXIF · SHA-256 · dHash
                     │  reads policy terms from the contract
                     ├──hash only──▶ registry  (/api/lookup, /api/claims)
                     │
                     └──signed FCC ActionResult──▶ browser
                                                     │
                              ClaimPayout.submitEvidence  ← ecrecover + vTPM quote check
                                                     │
                              ClaimPayout.settle ──▶ FDC Web2Json proof (rainfall)
                                                     └▶ FTSOv2 FLR/USD ──▶ payout
```

Surfaces: `/` the pitch and a real settled claim · `/claim` the claimant flow · `/desk` the insurer's live view of the chain · `/registry` the original media-provenance registry this was built on.

## Run it

```bash
npm install
npm test                 # 91 unit tests
npm run dev              # the app

cd enclave && npm install && node server.mjs    # the verifier, dev mode (attested=false)
```

Health check before any demo — wallets drain, quotes expire hourly, and Google rotates its signing keys:

```bash
node scripts/health-check.mjs
node scripts/register-oidc-keys.mjs --check
```

On this machine Node needs `NODE_OPTIONS=--use-system-ca` to reach the Coston2 RPC through the local TLS interception.

## What was built before this hackathon, and what was built during it

This project began as **Proof of Real**, a media-provenance registry built for a previous hackathon. That origin is stated plainly here because Summer Signal judges on evidence of new work during the program.

**Pre-existing (before 14 July 2026):** the Next.js registry, SHA-256 + dHash fingerprinting, the Ed25519-sealed hash-chained ledger, and LSH near-match. That prior work lives on at `/registry`.

**Built during the program:** everything Flare, everything confidential, and the entire insurance product — the anchor contract, `ClaimPayout.sol`, the vTPM attestation gating, the FDC Web2Json settlement path, FTSOv2 conversion, the enclave, the claim-intake forensics, the cross-claim fraud detection, the Supabase backend, and all three Adjuster surfaces.

[`docs/work-ledger.md`](docs/work-ledger.md) is the dated, commit-linked record of every substantial change.

## Honest limitations

Stated because a demo that overclaims is worth less than one that doesn't.

- **The enclave has not yet run in real Confidential Space.** The attestation path is fully implemented and the four live Google Confidential Space signing keys are registered on-chain, but the deployment is blocked on cloud billing, so verdicts currently come from the dev-signer path and report `attested=false`. The contract records attested-versus-dev on every settlement rather than hiding the difference. **Nothing in this README claims an attestation that has happened.**
- **Testnet only.** Coston2, test funds, not production insurance.
- The demo relays transactions from a server wallet so a judge needs no wallet — a custody shortcut, not a design.
- dHash is defeated by cropping and rotation; it catches re-encoding, resizing, and light edits.
- One enclave, so no multi-node agreement on a verdict.
- `/claim` has no rate limiting or authentication.
- No pool reservation accounting — concurrent settlements could race for the same funds.
- EXIF timestamps carry timezone ambiguity of up to a day at coverage-window edges.
- The contracts are covered by live end-to-end scripts against Coston2, not by unit tests.
- Open-Meteo's archive lags roughly five days, so demo policies must use dates at least a week old.

## Roadmap

Confidential Space deployment and real attestation · registration as a genuine FCC extension on Coston2 · a C2PA-conformant Soft Binding Resolution API endpoint ([ISO/IEC 22144](https://c2pa.org/) defines exactly the hard and soft bindings used here) · FXRP payouts · multi-node verifier agreement.

## License

MIT
