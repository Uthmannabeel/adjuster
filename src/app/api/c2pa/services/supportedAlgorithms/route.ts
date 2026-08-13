import { SOFT_BINDING_ALG } from "@/lib/c2pa";

export const runtime = "nodejs";

/**
 * C2PA Soft Binding Resolution API — GET /services/supportedAlgorithms.
 * Deliberately unauthenticated: it names the algorithm this resolver speaks
 * and reveals nothing about registry contents.
 */
export async function GET(): Promise<Response> {
  return Response.json({
    watermarks: [],
    fingerprints: [{ alg: SOFT_BINDING_ALG }],
  });
}
