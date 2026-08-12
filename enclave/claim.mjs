// Claim-evidence checks — pure logic, no I/O. The enclave runs these against
// EXIF extracted in TEE memory and a hash-only registry lookup, producing the
// evidence verdict that the FCC-format settlement is signed over.
import { isDegeneratePerceptualHash } from "./hash.mjs";

const EARTH_RADIUS_KM = 6371;
export const DEFAULT_MAX_DISTANCE_KM = 5;
export const DEFAULT_WINDOW_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Great-circle distance between two WGS84 points, in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Whole days between a photo timestamp and a coverage date ("YYYY-MM-DD"), by UTC day. */
export function daysFromCoverage(takenAtIso, coverageDate) {
  const taken = Date.parse(takenAtIso);
  const coverage = Date.parse(`${coverageDate}T00:00:00Z`);
  if (Number.isNaN(taken) || Number.isNaN(coverage)) return null;
  const takenDay = Math.floor(taken / MS_PER_DAY);
  const coverageDay = Math.floor(coverage / MS_PER_DAY);
  return Math.abs(takenDay - coverageDay);
}

/**
 * Run all claim-evidence checks.
 *
 * @param exif    { gpsLat, gpsLon, takenAt, camera } from extractExif
 * @param policy  { lat, lon, date, maxKm?, windowDays? } — the insured location/date
 * @param lookup  { exact, near } from the hash-only registry lookup; any match on a
 *                prior claim record means this evidence was already used.
 * @param phash   the submitted image's perceptual fingerprint, when available —
 *                used to tell a real near-match from an uncomparable image.
 * @returns { eligible, checks: [{ id, pass, finding }] }
 */
export function runClaimChecks(exif, policy, lookup, phash = null) {
  const maxKm = policy.maxKm ?? DEFAULT_MAX_DISTANCE_KM;
  const windowDays = policy.windowDays ?? DEFAULT_WINDOW_DAYS;
  const checks = [];

  const hasGps = exif.gpsLat !== null && exif.gpsLon !== null;
  let distanceKm = null;
  if (hasGps) {
    distanceKm = haversineKm(exif.gpsLat, exif.gpsLon, policy.lat, policy.lon);
    checks.push({
      id: "location-match",
      pass: distanceKm <= maxKm,
      finding:
        distanceKm <= maxKm
          ? `Photo GPS is ${distanceKm.toFixed(2)} km from the insured location (limit ${maxKm} km).`
          : `Photo GPS is ${distanceKm.toFixed(2)} km from the insured location — outside the ${maxKm} km limit.`,
    });
  } else {
    checks.push({
      id: "location-match",
      pass: false,
      finding: "Photo carries no GPS metadata, so the location cannot be verified.",
    });
  }

  let dayGap = null;
  if (exif.takenAt) {
    dayGap = daysFromCoverage(exif.takenAt, policy.date);
    const pass = dayGap !== null && dayGap <= windowDays;
    checks.push({
      id: "time-match",
      pass,
      finding: pass
        ? `Photo taken ${dayGap} day(s) from the coverage date (window ${windowDays} days).`
        : `Photo timestamp is ${dayGap ?? "unreadable"} day(s) from the coverage date — outside the ${windowDays}-day window.`,
    });
  } else {
    checks.push({
      id: "time-match",
      pass: false,
      finding: "Photo carries no capture timestamp, so the date cannot be verified.",
    });
  }

  // An image with no texture fingerprints to the same value as every other
  // featureless image, so a perceptual "match" against one proves nothing. Such
  // evidence is rejected rather than compared: accepting it would let a
  // fraudster defeat reuse detection with a blank frame, and trusting the match
  // would accuse an honest claimant of recycling a photo they never saw.
  const comparable = phash === null || !isDegeneratePerceptualHash(phash);
  if (!comparable) {
    checks.push({
      id: "image-detail",
      pass: false,
      finding:
        "This image has too little visual detail to fingerprint — it cannot be checked against"
        + " prior claims. Photograph the damage in better light, filling more of the frame.",
    });
  }

  // Exact byte matches always count; a perceptual near-match only counts when
  // the fingerprint carries enough information to mean something. A claimant
  // re-uploading their own evidence for the SAME policy is a retry, not fraud
  // — but that retry must never mask a match against ANOTHER policy, so the
  // near-match is judged independently of the exact one (the registry searches
  // past the claimant's own records when asked via `exclude`, and this logic
  // filters own-policy records again as a second line of defence).
  const own =
    policy.policyId !== undefined ? `adjuster:policy:${policy.policyId}` : null;
  const exact = lookup?.exact ?? null;
  const samePolicyExact = exact !== null && own !== null && exact.registrant === own;
  const near = comparable ? (lookup?.near?.record ?? null) : null;
  const crossNear = near !== null && own !== null && near.registrant === own ? null : near;
  const crossExact = exact !== null && !samePolicyExact ? exact : null;
  const reuseMatch = crossExact ?? crossNear;
  const reuseDetected = Boolean(reuseMatch);
  checks.push({
    id: "no-reuse",
    pass: !reuseDetected,
    finding: reuseDetected
      ? `This image ${crossExact ? "exactly matches" : `perceptually matches (distance ${lookup.near.distance}/64)`} evidence already on file: "${reuseMatch.title}".`
      : samePolicyExact
        ? "Matches this policy's own earlier submission — treated as a re-upload, not reuse."
        : comparable
          ? "No exact or near match against previously submitted evidence."
          : "No exact match on file; perceptual comparison was not possible for this image.",
  });

  const eligible = checks.every((c) => c.pass);
  return { eligible, reuseDetected, comparable, distanceKm, dayGap, checks };
}
