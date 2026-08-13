import { getStore } from "@/lib/store";
import { presentedKey, resolveByBinding } from "@/lib/c2pa";

export const runtime = "nodejs";

/**
 * C2PA Soft Binding Resolution API — GET/POST /matches/byBinding.
 *
 * Responses use the spec's bare shape ({ matches: [...] }), not this app's
 * ApiResponse envelope: the whole point of the route is that a C2PA client
 * built against the spec can call it unchanged.
 *
 * Auth mirrors /api/lookup: when REGISTRY_LOOKUP_KEY is set the caller must
 * present it (spec-conventional `Authorization: Bearer` or the enclave's
 * x-registry-lookup-key header). An open resolver would be a membership
 * oracle for the registry — the same probing surface the lookup key exists
 * to close.
 */

function unauthorized(request: Request): Response | null {
  const requiredKey = process.env.REGISTRY_LOOKUP_KEY;
  if (!requiredKey) return null;
  const presented = presentedKey(
    request.headers.get("authorization"),
    request.headers.get("x-registry-lookup-key"),
  );
  if (presented === requiredKey) return null;
  return Response.json(
    { error: "This resolver requires a bearer token." },
    { status: 401 },
  );
}

async function answer(
  request: Request,
  params: { alg: string | null; value: string | null; maxResults: string | null },
): Promise<Response> {
  const denied = unauthorized(request);
  if (denied) return denied;
  try {
    const store = await getStore();
    const result = await resolveByBinding(params, (phash, maxDistance) =>
      store.findNearest(phash, maxDistance),
    );
    return Response.json(result.body, { status: result.status });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Resolution failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return answer(request, {
    alg: url.searchParams.get("alg"),
    value: url.searchParams.get("value"),
    maxResults: url.searchParams.get("maxResults"),
  });
}

/** Spec variant for binding values too large for a URL; ours never are, but a conformant client may still POST. */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let body: { alg?: unknown; value?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON: { alg, value }." }, { status: 400 });
  }
  return answer(request, {
    alg: typeof body.alg === "string" ? body.alg : null,
    value: typeof body.value === "string" ? body.value : null,
    maxResults: url.searchParams.get("maxResults"),
  });
}
