import { describe, expect, it } from "vitest";
import { startTls, tlsConfig } from "./tls.mjs";

describe("tlsConfig", () => {
  it("is disabled when no domain is configured", () => {
    const config = tlsConfig({});
    expect(config.enabled).toBe(false);
    expect(config.domain).toBe(null);
  });

  it("reads the domain, contact and staging switch", () => {
    const config = tlsConfig({
      TLS_DOMAIN: "enclave.example.com",
      TLS_EMAIL: "ops@example.com",
      TLS_STAGING: "true",
    });
    expect(config).toMatchObject({
      enabled: true,
      domain: "enclave.example.com",
      email: "ops@example.com",
      staging: true,
    });
  });

  it("treats a blank domain as unset rather than enabling TLS for ''", () => {
    expect(tlsConfig({ TLS_DOMAIN: "   " }).enabled).toBe(false);
  });

  it("only enables staging on an exact 'true'", () => {
    expect(tlsConfig({ TLS_DOMAIN: "a.example.com", TLS_STAGING: "1" }).staging).toBe(false);
  });

  it("defaults to the ports Let's Encrypt and browsers actually use", () => {
    const config = tlsConfig({ TLS_DOMAIN: "a.example.com" });
    // http-01 validation only ever connects to port 80 — it is not negotiable.
    expect(config.challengePort).toBe(80);
    expect(config.httpsPort).toBe(443);
  });
});

describe("startTls", () => {
  it("reports inactive instead of throwing when TLS is not configured", async () => {
    const result = await startTls(() => {}, tlsConfig({}));
    expect(result).toEqual({ active: false, reason: "TLS_DOMAIN not set" });
  });

  it("reports why it failed rather than leaving the enclave dark", async () => {
    // Port 0 is not bindable as a listen target for the challenge server here;
    // whatever the failure, the enclave must keep serving and say why.
    const result = await startTls(() => {}, {
      ...tlsConfig({ TLS_DOMAIN: "enclave.invalid" }),
      challengePort: -1,
    });
    expect(result.active).toBe(false);
    expect(result.reason).toMatch(/could not bind/);
  });
});
