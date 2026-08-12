import { describe, expect, it } from "vitest";
import { daysFromCoverage, haversineKm, runClaimChecks } from "./claim.mjs";
import { dmsToDecimal } from "./exif.mjs";

// Port Harcourt city centre vs a point ~1.2 km away, and vs Lagos (~500 km).
const PH = { lat: 4.8156, lon: 7.0498 };
const PH_NEARBY = { lat: 4.8253, lon: 7.0552 };
const LAGOS = { lat: 6.5244, lon: 3.3792 };

const GOOD_EXIF = {
  gpsLat: PH_NEARBY.lat,
  gpsLon: PH_NEARBY.lon,
  takenAt: "2026-07-10T14:30:00.000Z",
  camera: "Samsung SM-A546B",
};
const POLICY = { lat: PH.lat, lon: PH.lon, date: "2026-07-10" };
const NO_MATCH = { exact: null, near: null };

describe("haversineKm", () => {
  it("measures a short urban distance correctly", () => {
    const km = haversineKm(PH.lat, PH.lon, PH_NEARBY.lat, PH_NEARBY.lon);
    expect(km).toBeGreaterThan(0.8);
    expect(km).toBeLessThan(1.6);
  });

  it("measures a cross-country distance correctly", () => {
    const km = haversineKm(PH.lat, PH.lon, LAGOS.lat, LAGOS.lon);
    expect(km).toBeGreaterThan(400);
    expect(km).toBeLessThan(500);
  });

  it("returns zero for identical points", () => {
    expect(haversineKm(PH.lat, PH.lon, PH.lat, PH.lon)).toBe(0);
  });
});

describe("daysFromCoverage", () => {
  it("returns 0 for a photo taken on the coverage date", () => {
    expect(daysFromCoverage("2026-07-10T23:59:00Z", "2026-07-10")).toBe(0);
  });

  it("counts whole UTC days across the boundary", () => {
    expect(daysFromCoverage("2026-07-13T00:01:00Z", "2026-07-10")).toBe(3);
    expect(daysFromCoverage("2026-07-07T12:00:00Z", "2026-07-10")).toBe(3);
  });

  it("returns null for unparseable input", () => {
    expect(daysFromCoverage("not-a-date", "2026-07-10")).toBeNull();
  });
});

describe("dmsToDecimal", () => {
  it("converts northern/eastern coordinates", () => {
    expect(dmsToDecimal([4, 48, 56.16], "N")).toBeCloseTo(4.8156, 3);
    expect(dmsToDecimal([7, 2, 59.28], "E")).toBeCloseTo(7.0498, 3);
  });

  it("negates for south and west hemispheres", () => {
    expect(dmsToDecimal([33, 52, 4], "S")).toBeCloseTo(-33.8678, 3);
    expect(dmsToDecimal([151, 12, 26], "W")).toBeCloseTo(-151.2072, 3);
  });

  it("returns null for malformed triplets", () => {
    expect(dmsToDecimal(null, "N")).toBeNull();
    expect(dmsToDecimal([1, 2], "N")).toBeNull();
  });
});

describe("runClaimChecks", () => {
  it("passes all checks for valid on-site, on-date, unused evidence", () => {
    const v = runClaimChecks(GOOD_EXIF, POLICY, NO_MATCH);
    expect(v.eligible).toBe(true);
    expect(v.reuseDetected).toBe(false);
    expect(v.checks.filter((c) => c.pass)).toHaveLength(3);
    expect(v.distanceKm).toBeLessThan(5);
  });

  it("fails location when GPS is missing", () => {
    const v = runClaimChecks({ ...GOOD_EXIF, gpsLat: null, gpsLon: null }, POLICY, NO_MATCH);
    expect(v.eligible).toBe(false);
    expect(v.checks.find((c) => c.id === "location-match").pass).toBe(false);
    expect(v.checks.find((c) => c.id === "location-match").finding).toMatch(/no GPS/);
  });

  it("fails location when the photo is far from the insured property", () => {
    const v = runClaimChecks({ ...GOOD_EXIF, gpsLat: LAGOS.lat, gpsLon: LAGOS.lon }, POLICY, NO_MATCH);
    expect(v.eligible).toBe(false);
    expect(v.checks.find((c) => c.id === "location-match").finding).toMatch(/outside/);
  });

  it("fails time when the photo is outside the coverage window", () => {
    const v = runClaimChecks({ ...GOOD_EXIF, takenAt: "2026-06-01T00:00:00Z" }, POLICY, NO_MATCH);
    expect(v.eligible).toBe(false);
    expect(v.checks.find((c) => c.id === "time-match").pass).toBe(false);
  });

  it("flags exact evidence reuse as fraud", () => {
    const lookup = { exact: { title: "Claim evidence — policy #1" }, near: null };
    const v = runClaimChecks(GOOD_EXIF, POLICY, lookup);
    expect(v.eligible).toBe(false);
    expect(v.reuseDetected).toBe(true);
    expect(v.checks.find((c) => c.id === "no-reuse").finding).toMatch(/exactly matches/);
  });

  it("flags near-duplicate evidence reuse with its distance", () => {
    const lookup = { exact: null, near: { distance: 4, record: { title: "Claim evidence — policy #2" } } };
    const v = runClaimChecks(GOOD_EXIF, POLICY, lookup);
    expect(v.eligible).toBe(false);
    expect(v.checks.find((c) => c.id === "no-reuse").finding).toMatch(/distance 4\/64/);
  });

  it("treats a same-policy match as a re-upload, not fraud", () => {
    const lookup = {
      exact: { title: "Claim evidence — policy #5", registrant: "adjuster:policy:5" },
      near: null,
    };
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 5 }, lookup);
    expect(v.reuseDetected).toBe(false);
    expect(v.checks.find((c) => c.id === "no-reuse").pass).toBe(true);
    expect(v.checks.find((c) => c.id === "no-reuse").finding).toMatch(/re-upload/);
  });

  it("still flags reuse when the match belongs to a different policy", () => {
    const lookup = {
      exact: { title: "Claim evidence — policy #5", registrant: "adjuster:policy:5" },
      near: null,
    };
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 6 }, lookup);
    expect(v.reuseDetected).toBe(true);
  });

  it("respects a custom distance limit", () => {
    const strict = runClaimChecks(GOOD_EXIF, { ...POLICY, maxKm: 0.5 }, NO_MATCH);
    expect(strict.eligible).toBe(false);
  });
});

// A featureless image (dark frame, blank wall) fingerprints to the same value
// as every other featureless image, so a near-match against one is meaningless.
const FLAT_PHASH = "0000000000000000";
const DETAILED_PHASH = "53393132e2b7cb59";

describe("uncomparable evidence", () => {
  const nearMatch = {
    exact: null,
    near: {
      record: { title: "Claim evidence — policy #5", registrant: "adjuster:policy:5" },
      distance: 2,
    },
  };

  it("does not accuse a claimant of reuse on a near-match it cannot trust", () => {
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 9 }, nearMatch, FLAT_PHASH);

    expect(v.reuseDetected).toBe(false);
    expect(v.checks.find((c) => c.id === "no-reuse").pass).toBe(true);
    expect(v.checks.find((c) => c.id === "no-reuse").finding).toMatch(/not possible/);
  });

  it("rejects the claim instead, so a blank frame cannot evade reuse detection", () => {
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 9 }, NO_MATCH, FLAT_PHASH);

    expect(v.comparable).toBe(false);
    expect(v.eligible).toBe(false);
    expect(v.checks.find((c) => c.id === "image-detail").finding).toMatch(/better light/);
  });

  it("still catches an exact byte match — identical bytes need no texture", () => {
    const exact = {
      exact: { title: "Claim evidence — policy #5", registrant: "adjuster:policy:5" },
      near: null,
    };
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 9 }, exact, FLAT_PHASH);

    expect(v.reuseDetected).toBe(true);
  });

  it("trusts near-matches normally when the image has real detail", () => {
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 9 }, nearMatch, DETAILED_PHASH);

    expect(v.comparable).toBe(true);
    expect(v.reuseDetected).toBe(true);
    expect(v.checks.some((c) => c.id === "image-detail")).toBe(false);
  });

  it("behaves exactly as before when no fingerprint is supplied", () => {
    const v = runClaimChecks(GOOD_EXIF, { ...POLICY, policyId: 9 }, nearMatch);

    expect(v.comparable).toBe(true);
    expect(v.reuseDetected).toBe(true);
  });
});

describe("runClaimChecks — retry masking (the audit's P2 hole, now closed)", () => {
  const ownRecord = {
    registrant: "adjuster:policy:7",
    title: "Claim evidence — policy #7",
    phash: "aaaaaaaaaaaaaaaa",
  };
  const otherRecord = {
    registrant: "adjuster:policy:3",
    title: "Claim evidence — policy #3",
    phash: "aaaaaaaaaaaaaaab",
  };
  const policy7 = { ...POLICY, policyId: 7 };
  // A phash with plenty of texture, so the comparability gate passes.
  const richPhash = "9c6337d29c6337d2";

  it("an own-policy exact match does NOT mask a cross-policy near match", () => {
    const lookup = { exact: ownRecord, near: { record: otherRecord, distance: 2 } };
    const verdict = runClaimChecks(GOOD_EXIF, policy7, lookup, richPhash);
    const reuse = verdict.checks.find((c) => c.id === "no-reuse");
    expect(verdict.reuseDetected).toBe(true);
    expect(reuse.pass).toBe(false);
    expect(reuse.finding).toContain("policy #3");
  });

  it("a pure same-policy retry still passes as a re-upload", () => {
    const lookup = { exact: ownRecord, near: null };
    const verdict = runClaimChecks(GOOD_EXIF, policy7, lookup, richPhash);
    const reuse = verdict.checks.find((c) => c.id === "no-reuse");
    expect(verdict.reuseDetected).toBe(false);
    expect(reuse.pass).toBe(true);
    expect(reuse.finding).toContain("re-upload");
  });

  it("a cross-policy exact match is still reuse", () => {
    const lookup = { exact: otherRecord, near: null };
    const verdict = runClaimChecks(GOOD_EXIF, policy7, lookup, richPhash);
    expect(verdict.reuseDetected).toBe(true);
  });

  it("an own-policy near match alone is not reuse (second line of defence)", () => {
    const lookup = { exact: null, near: { record: ownRecord, distance: 1 } };
    const verdict = runClaimChecks(GOOD_EXIF, policy7, lookup, richPhash);
    expect(verdict.reuseDetected).toBe(false);
  });
});
