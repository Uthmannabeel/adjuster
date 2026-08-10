# Confidential verifier enclave

The verifier runs in **Google Cloud Confidential Space** — a hardened TEE
(Intel TDX / AMD SEV) whose launcher measures the container image and issues
Google-signed attestation tokens.

## Privacy architecture

```
browser ──(image, TLS)──▶ enclave (Confidential Space VM)
                            │  fingerprints in enclave memory only
                            │  image never stored, never forwarded
                            ▼
                          registry ◀──(hashes only)── /api/lookup
                            │
                            ▼
browser ◀─ verdict + attestation JWT (nonce = file SHA-256)
```

- The registry server **never receives the image** — only its hashes.
- The attestation token proves *which container image* processed the file, on
  *which confidential hardware*, and is **nonce-bound to the file's SHA-256**.
- Verifiers can check the token against Google's OIDC keys
  (`https://confidentialcomputing.googleapis.com/.well-known/openid-configuration`)
  and compare `submods.container.image_digest` with the published image digest.

## Local development

```bash
node enclave/server.mjs                      # REGISTRY_URL defaults to http://localhost:3000
# app: set NEXT_PUBLIC_ENCLAVE_URL=http://localhost:8080 in .env.local
```

Outside Confidential Space the service runs in clearly-labelled dev mode:
verdicts work, `enclave.attested` stays `false`.

## Production deployment (Confidential Space)

One command, from a fresh GCP project to an enclave whose in-TEE key is attested
on Flare:

```bash
node scripts/deploy-enclave.mjs \
  --registry-url https://YOUR-APP-URL \
  --tls-domain enclave.example.com --tls-email you@example.com
```

Every stage is idempotent, so a failure is fixed by fixing the cause and running
the same command again. `--from <stage>` resumes, `--only <stage>` runs one,
`--list` prints them:

```
preflight → apis → repo → sa → build → ip → firewall → vm → wait → pin → fund
```

`ip` reserves a static address **before** the VM exists, so the A record for
`--tls-domain` can be pointed at it in advance. `pin` writes the running image's
digest into `FlareVtpmAttestation`, and `fund` tops up the in-enclave key so it
can pay for its own attestation transaction.

Cost: Confidential Space itself is free; you pay for the underlying VM
(c3-standard-4 on-demand ≈ $0.20/hr — run it for demos, stop it after).

## TLS terminates inside the enclave

The confidentiality claim is that the image is seen only by measured code on
confidential hardware. A load balancer, an nginx sidecar, or a tunnel provider
would each hold the plaintext image and quietly break that claim — so the
enclave gets its own certificate instead.

- The certificate key is generated **in enclave memory**, never written to disk.
- Let's Encrypt issues over HTTP-01 on port 80; the enclave serves browsers on 443.
- On restart, a fresh key is generated and a fresh certificate issued. Nothing
  about the TLS identity survives a reboot, by design.
- Port 8080 stays plaintext but answers `/health` **only** — once TLS is live it
  returns `426` for anything carrying an image.

`TLS_DOMAIN` must be a name you control, pointed at the reserved address. An
IP-literal hostname service such as `sslip.io` will not do: it is absent from the
Public Suffix List, so Let's Encrypt's per-registered-domain rate limit is shared
with every other user of it.

Set `TLS_STAGING=true` to rehearse against Let's Encrypt's staging environment
without consuming the production rate limit (browsers will not trust the result).

Then set `NEXT_PUBLIC_ENCLAVE_URL=https://enclave.example.com` on the app
deployment — `deploy-enclave.mjs` writes it into `.env.local` for you.

## Attestation token claims worth showing judges

| Claim | Meaning |
|---|---|
| `hwmodel` | e.g. `INTEL_TDX` — the confidential hardware |
| `swname` | `CONFIDENTIAL_SPACE` |
| `submods.container.image_digest` | digest of THIS verifier image |
| `eat_nonce` | SHA-256 of the exact file that was verified |
| `iss` | `https://confidentialcomputing.googleapis.com` |
