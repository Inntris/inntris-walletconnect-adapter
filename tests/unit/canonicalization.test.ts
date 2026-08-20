import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalise, hashCanonical } from "../../src/cwp/input.js";
import { canonicalCoreTimestamp } from "../../src/inntris/signing.js";

/**
 * The cross-language canonicalization contract.
 *
 * These vectors are copied verbatim from Inntris Core
 * (`tests/fixtures/canonicalization/jcs_vectors.json`). If this suite fails,
 * the adapter's signatures will not verify under `sig_version=3` — the failure
 * is in canonicalization, not in the signing key.
 */
interface JcsVector {
  name: string;
  input: unknown;
  canonical: string;
  sha256: string;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "jcs_vectors.json"), "utf-8"),
) as { sig_version: number; vectors: JcsVector[] };

describe("RFC 8785 JCS canonicalization", () => {
  it("targets signing envelope version 3", () => {
    expect(fixture.sig_version).toBe(3);
  });

  it("has the full Core vector set", () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(12);
  });

  for (const vector of fixture.vectors) {
    it(`matches Core canonical bytes: ${vector.name}`, () => {
      expect(canonicalise(vector.input)).toBe(vector.canonical);
    });

    it(`matches Core SHA-256: ${vector.name}`, () => {
      expect(hashCanonical(vector.input)).toBe(vector.sha256);
    });
  }
});

describe("canonicalCoreTimestamp", () => {
  it("drops the fractional part at whole seconds, matching Python isoformat", () => {
    expect(canonicalCoreTimestamp(new Date("2026-08-20T12:00:00.000Z"))).toBe(
      "2026-08-20T12:00:00Z",
    );
  });

  it("pads to six fractional digits, matching Python microseconds", () => {
    expect(canonicalCoreTimestamp(new Date("2026-08-20T12:00:00.123Z"))).toBe(
      "2026-08-20T12:00:00.123000Z",
    );
  });

  it("normalises a non-UTC offset to UTC", () => {
    expect(canonicalCoreTimestamp("2026-08-20T14:00:00+02:00")).toBe("2026-08-20T12:00:00Z");
  });

  it("rejects an invalid timestamp rather than hashing garbage", () => {
    expect(() => canonicalCoreTimestamp("not-a-date")).toThrow(/invalid timestamp/iu);
  });
});
