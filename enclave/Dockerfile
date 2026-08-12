# Adjuster — confidential claims enclave image.
# Built for Google Cloud Confidential Space: the launcher measures this image's
# digest into the attestation token, so keep it minimal and reproducible.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# npm ci against the committed lockfile — the image digest must be a function of
# the source, not of whatever the registry served today.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY hash.mjs exif.mjs claim.mjs fcc.mjs attestation.mjs attest.mjs tls.mjs parse.mjs parse-worker.mjs server.mjs ./

# Confidential Space runs the container as-is; no shell entrypoint tricks.
# 8080 is the plaintext port (health + dev); 443 serves browsers once the
# enclave has issued itself a certificate, 80 answers the ACME challenge.
# Binding the low ports needs the capability, hence root — the workload is a
# single measured process, so there is no privilege boundary to cross here.
EXPOSE 80 443 8080
CMD ["node", "server.mjs"]

# Confidential Space requires these labels for logging visibility choices.
# TEE_SIGNING_KEY is deliberately NOT overridable: inside the enclave the
# signing key is generated in-enclave and earns its authority by attesting
# on-chain, so nobody — including whoever runs the VM — can sign as this enclave.
# TLS_* is overridable: naming the hostname does not grant any authority — the
# certificate key is generated in-enclave and the signing key still earns its
# authority by attesting on-chain.
LABEL "tee.launch_policy.allow_env_override"="REGISTRY_URL,ALLOWED_ORIGIN,ATTESTATION_AUDIENCE,FLARE_RPC_URL,FLARE_VTPM_ADDRESS,TLS_DOMAIN,TLS_EMAIL,TLS_STAGING,REGISTRY_LOOKUP_KEY"
LABEL "tee.launch_policy.log_redirect"="always"
