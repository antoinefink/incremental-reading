import { describe, expect, it } from "vitest";
import {
  deriveExpiryStatus,
  EMPTY_FACT_LIFETIME,
  expiryLabel,
  FACT_STABILITY,
  type FactLifetime,
  hasFactLifetime,
  isFactStability,
  lifetimeToRecencySignals,
} from "./fact-lifetime";

const NOW = new Date("2026-06-01T12:00:00Z");

/** Build a lifetime, defaulting every field to absent. */
function lifetime(partial: Partial<FactLifetime>): FactLifetime {
  return { ...EMPTY_FACT_LIFETIME, ...partial };
}

describe("FACT_STABILITY tuple + guard", () => {
  it("is the closed restrained vocabulary", () => {
    expect(FACT_STABILITY).toEqual(["stable", "slow", "volatile"]);
  });

  it("guards membership", () => {
    expect(isFactStability("stable")).toBe(true);
    expect(isFactStability("slow")).toBe(true);
    expect(isFactStability("volatile")).toBe(true);
    expect(isFactStability("durable")).toBe(false);
    expect(isFactStability("")).toBe(false);
    expect(isFactStability(null)).toBe(false);
    expect(isFactStability(3)).toBe(false);
  });
});

describe("deriveExpiryStatus", () => {
  it("is fresh for a null / empty lifetime (the common case)", () => {
    expect(deriveExpiryStatus(null, NOW)).toBe("fresh");
    expect(deriveExpiryStatus(undefined, NOW)).toBe("fresh");
    expect(deriveExpiryStatus(EMPTY_FACT_LIFETIME, NOW)).toBe("fresh");
  });

  it("is expired when now is past valid_until", () => {
    expect(deriveExpiryStatus(lifetime({ validUntil: "2025-01-01" }), NOW)).toBe("expired");
  });

  it("is fresh when valid_until is in the future", () => {
    expect(deriveExpiryStatus(lifetime({ validUntil: "2027-01-01" }), NOW)).toBe("fresh");
  });

  it("is due_for_review when past review_by but valid_until is future/absent", () => {
    expect(deriveExpiryStatus(lifetime({ reviewBy: "2025-09-01" }), NOW)).toBe("due_for_review");
    expect(
      deriveExpiryStatus(lifetime({ reviewBy: "2025-09-01", validUntil: "2027-01-01" }), NOW),
    ).toBe("due_for_review");
  });

  it("expired dominates due_for_review when both are past", () => {
    expect(
      deriveExpiryStatus(lifetime({ reviewBy: "2025-01-01", validUntil: "2025-02-01" }), NOW),
    ).toBe("expired");
  });

  it("is fresh when review_by is in the future", () => {
    expect(deriveExpiryStatus(lifetime({ reviewBy: "2027-01-01" }), NOW)).toBe("fresh");
  });

  it("treats valid_from as informational — a future window is still fresh, not expired", () => {
    expect(deriveExpiryStatus(lifetime({ validFrom: "2030-01-01" }), NOW)).toBe("fresh");
  });

  it("treats unparseable / empty dates as absent (no constraint) and never throws", () => {
    expect(deriveExpiryStatus(lifetime({ validUntil: "not-a-date" }), NOW)).toBe("fresh");
    expect(deriveExpiryStatus(lifetime({ validUntil: "" }), NOW)).toBe("fresh");
    expect(deriveExpiryStatus(lifetime({ validUntil: "   " }), NOW)).toBe("fresh");
    expect(deriveExpiryStatus(lifetime({ reviewBy: "soon" }), NOW)).toBe("fresh");
  });

  it("parses a bare ISO date as UTC midnight (host-timezone-independent)", () => {
    // 2026-06-01T12:00Z is AFTER 2026-06-01T00:00Z → expired regardless of host TZ.
    expect(deriveExpiryStatus(lifetime({ validUntil: "2026-06-01" }), NOW)).toBe("expired");
  });

  it("accepts full ISO timestamps too", () => {
    expect(deriveExpiryStatus(lifetime({ validUntil: "2026-06-01T11:00:00Z" }), NOW)).toBe(
      "expired",
    );
    expect(deriveExpiryStatus(lifetime({ validUntil: "2026-06-01T13:00:00Z" }), NOW)).toBe("fresh");
  });

  it("ignores display-only fields (jurisdiction / version / stability)", () => {
    expect(
      deriveExpiryStatus(
        lifetime({ jurisdiction: "EU", softwareVersion: "React 19", factStability: "volatile" }),
        NOW,
      ),
    ).toBe("fresh");
  });
});

describe("hasFactLifetime", () => {
  it("is false for null / empty", () => {
    expect(hasFactLifetime(null)).toBe(false);
    expect(hasFactLifetime(EMPTY_FACT_LIFETIME)).toBe(false);
    expect(hasFactLifetime(lifetime({ validUntil: "  " }))).toBe(false);
  });

  it("is true when any field is set", () => {
    expect(hasFactLifetime(lifetime({ factStability: "stable" }))).toBe(true);
    expect(hasFactLifetime(lifetime({ validUntil: "2027-01-01" }))).toBe(true);
    expect(hasFactLifetime(lifetime({ jurisdiction: "US-CA" }))).toBe(true);
    expect(hasFactLifetime(lifetime({ softwareVersion: "Node 22" }))).toBe(true);
    expect(hasFactLifetime(lifetime({ reviewBy: "2026-01-01" }))).toBe(true);
  });
});

describe("lifetimeToRecencySignals (T090 → T086 bridge)", () => {
  it("marks an expired fact stale and uses valid_from as the source date", () => {
    const signals = lifetimeToRecencySignals(
      lifetime({ validUntil: "2025-01-01", validFrom: "2020-01-01" }),
      NOW,
    );
    expect(signals.sourceIsStale).toBe(true);
    expect(signals.sourceDate).toBe("2020-01-01");
  });

  it("marks a due_for_review fact stale", () => {
    expect(lifetimeToRecencySignals(lifetime({ reviewBy: "2025-09-01" }), NOW).sourceIsStale).toBe(
      true,
    );
  });

  it("a fresh / lifetime-less fact is not stale", () => {
    expect(lifetimeToRecencySignals(null, NOW).sourceIsStale).toBe(false);
    expect(
      lifetimeToRecencySignals(lifetime({ validUntil: "2030-01-01" }), NOW).sourceIsStale,
    ).toBe(false);
  });

  it("falls back to the source published date when valid_from is absent", () => {
    const signals = lifetimeToRecencySignals(
      lifetime({ reviewBy: "2025-09-01" }),
      NOW,
      "2019-05-01",
    );
    expect(signals.sourceDate).toBe("2019-05-01");
  });

  it("returns null source date when neither valid_from nor published date is present", () => {
    expect(
      lifetimeToRecencySignals(lifetime({ validUntil: "2025-01-01" }), NOW).sourceDate,
    ).toBeNull();
  });
});

describe("expiryLabel", () => {
  it("is null for fresh", () => {
    expect(expiryLabel("fresh", lifetime({ validUntil: "2027-01-01" }))).toBeNull();
  });

  it("formats expired with the valid_until date", () => {
    expect(expiryLabel("expired", lifetime({ validUntil: "2025-01-01" }))).toBe(
      "Expired 2025-01-01",
    );
  });

  it("formats due_for_review with the review_by date", () => {
    expect(expiryLabel("due_for_review", lifetime({ reviewBy: "2026-09-01" }))).toBe(
      "Review by 2026-09-01",
    );
  });

  it("degrades cleanly when the relevant date is missing", () => {
    expect(expiryLabel("expired", EMPTY_FACT_LIFETIME)).toBe("Expired");
    expect(expiryLabel("due_for_review", EMPTY_FACT_LIFETIME)).toBe("Due for review");
    expect(expiryLabel("expired", null)).toBe("Expired");
  });
});
