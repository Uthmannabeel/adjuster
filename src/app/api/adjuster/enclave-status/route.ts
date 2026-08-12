import { ok } from "@/lib/api";
import { enclaveAttestationStatus } from "@/lib/adjuster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pre-upload attestation check for the claim page: verifies ON-CHAIN that the
 * enclave the browser is about to send a photograph to holds a live vTPM
 * quote for the container image it claims to run. See enclaveAttestationStatus.
 */
export async function GET(): Promise<Response> {
  return ok(await enclaveAttestationStatus());
}
