import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("./scale.bench.ts", import.meta.url), "utf8");

describe("scale bench registration", () => {
  it("keeps every hot read path in the informational benchmark table", () => {
    expect(source).toContain("QueueQuery.list (daily queue, full mode)");
    expect(source).toContain("QueueQuery.list (concept-filtered");
    expect(source).toContain("SearchRepository.search (multi-term FTS)");
    expect(source).toContain("EmbeddingRepository.knn (vec0 KNN)");
    expect(source).toContain("ReviewSessionService.nextReviewCard");
    expect(source).toContain("AnalyticsService.computeAnalytics");
    expect(source).toContain("MaintenanceQuery.report");
  });

  it("uses the shared bench world and provenance header instead of ad hoc setup", () => {
    expect(source).toContain("buildBenchWorld()");
    expect(source).toContain("provenanceHeader(world");
    expect(source).toContain("world?.cleanup()");
  });
});
