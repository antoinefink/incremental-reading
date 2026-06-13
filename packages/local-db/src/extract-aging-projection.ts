export type ExtractAgeBand = "fresh" | "aging" | "stale" | "graveyard";

export interface ExtractAgingThresholdSnapshot {
  readonly returnThreshold: number;
  readonly ageDays: number;
  readonly sweepLimit: number;
}

export interface ExtractAgingProjection {
  readonly band: ExtractAgeBand;
  readonly daysSinceProgress: number;
  readonly postponeCount: number;
  readonly thresholdReached: boolean;
}

export function projectExtractAging(
  daysSinceProgress: number,
  postponeCount: number,
  thresholds: Pick<ExtractAgingThresholdSnapshot, "returnThreshold" | "ageDays">,
): ExtractAgingProjection {
  const safeDays = Math.max(0, daysSinceProgress);
  const safePostpones = Math.max(0, postponeCount);
  const thresholdReached =
    safeDays >= thresholds.ageDays && safePostpones >= thresholds.returnThreshold;
  return {
    band: ageBandFor(safeDays, thresholds.ageDays),
    daysSinceProgress: safeDays,
    postponeCount: safePostpones,
    thresholdReached,
  };
}

function ageBandFor(daysSinceProgress: number, ageDays: number): ExtractAgeBand {
  if (daysSinceProgress < Math.max(1, Math.floor(ageDays / 2))) return "fresh";
  if (daysSinceProgress < ageDays) return "aging";
  if (daysSinceProgress < ageDays * 2) return "stale";
  return "graveyard";
}
