# Proof of Real — Devpost submission

**Track:** Open Innovation
**Built with:** Vercel · Next.js 16 · AWS DynamoDB · TypeScript

## Inspiration

Generative media made one question urgent and unanswerable for ordinary people: *is this real?* Detectors that claim to spot "AI images" are a losing arms race — and they fail silently on the images that matter most. We flipped the problem. Instead of guessing whether an unknown image is fake, let creators **prove** an image is theirs, and let anyone **check** it. Provenance as a public lookup, not a private claim.

## What it does

Proof of Real is a public, tamper-evident authenticity registry.

- **Register** an original photo → we seal its exact-byte hash (SHA-256) and a perceptual fingerprint (dHash) into a public ledger and issue a certificate.
- **Verify** any image → instant verdict: **registered original**, **altered copy of a registered original** (with a confidence score), or **unregistered** — no account, no trust required.

## How we built it

- **Frontend & API:** Next.js 16 (App Router, React 19) on Vercel. Multipart upload to Node-runtime route handlers that compute SHA-256 + dHash with `sharp`.
- **Database:** AWS DynamoDB, single-table design with three GSIs — `CONTENT#` for O(1) exact-original lookup, `BUCKET#` for perceptual-fingerprint candidates ranked by Hamming distance, and `ALL` for the time-ordered public ledger. `PAY_PER_REQUEST` billing.
- **Architecture:** a `ProvenanceStore` Repository interface with a local JSON backend for development and a DynamoDB backend for production — the same code runs in both, selected by one env var.

## Honesty by design

We deliberately built a **registry**, not a "deepfake detector." It makes a guarantee it can actually keep: provenance for media that was registered, verifiable by anyone, with no opaque model in the loop. That honesty is the point — it's what makes the verdict trustworthy.

## Challenges

Distinguishing "an edit of the original" from "a different image entirely" required pairing an exact hash with a perceptual hash and tuning the Hamming-distance threshold. We verified the full flow end-to-end: an original registers, the exact file verifies at distance 0, a brightness+blur edit verifies as *altered* at distance 5/64 (92% confidence), and an unrelated image correctly returns *unregistered*.

## What's next

Video and audio fingerprinting, LSH banding for perceptual matching at scale, and signed capture (C2PA) plus authenticated registrants to harden "who registered this."

## Links

- Live app: <!-- TODO: Vercel URL -->
- Repository: https://github.com/Uthmannabeel/adjuster
- Demo video: <!-- TODO -->
