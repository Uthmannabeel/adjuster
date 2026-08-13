# Summer Signal submission — copy for the DoraHacks BUIDL form

Every required field from the submission guidelines, in order. Paste each section
into the matching form field.

---

## Project name

**Adjuster**

## Selected bounty

Confidential Compute Apps

## Short product description

Adjuster is the confidential evidence layer for parametric insurance. A claimant
photographs storm damage; the photo is verified *inside a Google Confidential Space
enclave* — checked for location, date, and cross-claim reuse fraud — and never seen
by the insurer or stored anywhere. The enclave's signed verdict settles a policy
on Flare: rainfall attested by FDC Web2Json, payout converted at the FTSOv2 price,
money paid in about four minutes.

A manual damage claim costs an insurer **$300–900 and takes 10–30 days**. Adjuster
settled one on-chain for **under $0.01 in gas in ~4 minutes**, without any human
ever seeing the photograph.

## Target user

Parametric insurers (weather, flood, crop) who need damage evidence without
becoming custodians of photographs of the insides of people's homes — and their
claimants, who today trade privacy for payment. Emerging-market flood insurance
is the founding case: the team is in Port Harcourt, Nigeria, where both the flooding
and the claims friction are real.

## Demo

- Live app: **https://adjuster.agentarc.online** (fallback: https://adjuster-psi.vercel.app)
  - `/` — the pitch, a real settled claim as the specimen file
  - `/claim` — the claimant flow: photo → enclave verdict → on-chain evidence → FDC weather → payout
  - `/desk` — the insurer's live view of the chain (policies, attestation state, pool)
- Live enclave (real Confidential Space, Intel TDX): **https://tee.agentarc.online/health**
- Demo video: **[LINK — record and paste]**

No wallet or login needed — the demo relays transactions so a judge can run a full
claim from a browser in under two minutes. Sample claim photos are generated
per-policy with correct EXIF.

## GitHub repo

https://github.com/Uthmannabeel/proof-of-real-h0 (public, MIT)

## How the project uses Flare

Four Flare protocols, each load-bearing — remove any one and the product stops working:

1. **vTPM attestation** (`flare-vtpm-attestation`, vendored + adapted): the contract
   verifies the enclave's Confidential Space token on-chain (RS256 against Google's
   live signing keys, registered on Coston2) and only accepts evidence signed by a
   key with a live attested quote. A tampered payload or an unattested signer
   reverts `NotAttestedTee` — spoof rejection is demonstrated live.
2. **FDC Web2Json**: rainfall at the policy's coordinates and date, attested from
   Open-Meteo with a Merkle proof. The contract pins the request URL *and* canonical
   query parameters so the attested figure cannot be redirected to another place or day.
3. **FTSOv2**: converts the policy's USD payout to FLR at the live feed price at settlement.
4. **FCC wire format**: the enclave signs verdicts as FCC `ActionResult`s
   (EIP-191/ecrecover), so the same enclave can register as a real FCC extension
   without changing the contract.

This closes a real gap in Flare's own `fcc-weather-insurance` example, which trusts
an owner-set `teeAddress`. In Adjuster the TEE **proves itself**: the signing key is
generated inside the enclave (the launch policy forbids injecting one), submits its
own attestation to `FlareVtpmAttestation.verifyAndAttest`, and re-attests hourly.
Along the way we hit and documented a bug that will bite any Flare vTPM integration:
gas estimation runs against the latest block, so a freshly-minted token's `iat`
always fails `block.timestamp` validation — the fix is to wait for chain time to
pass `iat` before submitting.

## What was newly built during the program

**Pre-existing (before 14 July):** a media-provenance registry from an earlier
hackathon — SHA-256 + perceptual hashing with LSH near-match, Ed25519-sealed
hash-chain ledger. It survives at `/registry`.

**Built during Summer Signal:** everything Flare, everything confidential, and the
entire insurance product — `ClaimPayout.sol` (FCC-format evidence settlement,
vTPM-gated signers, FDC-pinned weather settlement, FTSOv2 conversion), the vTPM
attestation gating with Google's live OIDC keys registered on-chain, the
Confidential Space enclave (in-enclave EXIF forensics, cross-claim perceptual-hash
fraud detection, degenerate-fingerprint rejection, in-enclave ACME TLS so no proxy
ever holds a plaintext image), the one-command TDX deploy tooling, and all three
product surfaces. A final hardening pass closed four attack surfaces we found by
auditing our own limitations: image decoding isolated in a secret-free child
process (a parser exploit can no longer reach the signing key), retry-masking in
fraud detection fixed and regression-tested, hash lookups key-gated against
membership probing, and a pre-upload gate that verifies the enclave's on-chain
vTPM quote *before* the browser sends a photograph. Dated, commit-linked record:
`docs/work-ledger.md` — every claim in it is clickable.

The registry also answers the **C2PA Soft Binding Resolution API** query shape
(ISO/IEC 22144 — its spec defines exactly our two mechanisms, exact hashes as
hard bindings and perceptual fingerprints as soft bindings). Soft-binding
resolvers today are centralized services; this one is backed by a decentralized
registry with TEE-verified evidence: `GET /api/c2pa/matches/byBinding` resolves
a base64 fingerprint to matching records with a spec-scale similarity score
(honest scope in the README: self-assigned algorithm id, record ids rather than
manifest stores).

## Contract addresses and deployment details (Coston2)

| What | Address / link |
|---|---|
| `ClaimPayout` | `0x8af8843C9F2474F0528970161bc4C1db62e3B8b9` |
| `FlareVtpmAttestation` | `0xdf7fb88FcE2a9457a1a174845d702bF91aC8E19A` |
| `OidcSignatureVerification` | `0xf9b394C4583eD23A1b97f93428ea9A3e70Ad5A74` |
| Enclave attestation tx (current image) | `0xdc81f580643a4e63f59ccceab0200e2dd0c92d8f255e683b9e181bcae6c8aa49` |
| Settled claims (photo → payout) | **#14 (fully attested TEE): `0x6b6f0a64…058557a6`** · #3: `0x6883b850…8db9e914` · #5: `0xbb40b3b6…901762ce` · #11: `0xdeb5e8e8…3d05b7ee` |

Enclave: Google Confidential Space, c3-standard-4 Intel TDX, image pinned by digest
on-chain; the on-chain quote's digest matches the running container.

## Roadmap / next steps

Registration as a genuine FCC extension on Coston2 → C2PA-conformant Soft Binding
Resolution API (ISO/IEC 22144 defines exactly the hard/soft bindings used here) →
FXRP payouts → multi-node verifier agreement. Honest limitations are stated in the
README rather than hidden: testnet only, hourly attestation gas, dHash's known
blind spots (crop/rotation), single enclave.
