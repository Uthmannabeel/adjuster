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

COPY hash.mjs exif.mjs claim.mjs fcc.mjs attestation.mjs attest.mjs server.mjs ./

# Confidential Space runs the container as-is; no shell entrypoint tricks.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

# Confidential Space requires these labels for logging visibility choices.
# TEE_SIGNING_KEY is deliberately NOT overridable: inside the enclave the
# signing key is generated in-enclave and earns its authority by attesting
# on-chain, so nobody — including whoever runs the VM — can sign as this enclave.
LABEL "tee.launch_policy.allow_env_override"="REGISTRY_URL,ALLOWED_ORIGIN,ATTESTATION_AUDIENCE,FLARE_RPC_URL,FLARE_VTPM_ADDRESS"
LABEL "tee.launch_policy.log_redirect"="always"
